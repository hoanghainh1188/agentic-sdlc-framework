// One evaluation run on the server, from the signed contract to the scored measures (task L04,
// design/ADR-M81 §2.3, §2.5, §2.8; QUESTIONS #460, #461, #463, #464). The order:
//
// 1. wait for a free evaluation slot (`SlotPool.acquireEvaluation`: free slots only; a real run
//    that needs the slot asks this run to stop, `onPreempt`);
// 2. verify the signed contract and claim the run (`queued → running`, one conditional update);
// 3. clone the sample repository at the contract's commit with a single-repository token (revoked
//    as soon as the clone ended), build the base of the task (spec, seed patch, instructions) from
//    the task set, and start the sandbox from it;
// 4. drive the agent with the run's capped virtual key (`driveEvaluationAgent`);
// 5. recompute the agent's change outside the sandbox with hardened git, remove the sandbox, and
//    score the change in the scoring containers (`scoreEvaluationRun`);
// 6. return the measures. The worker adds the model calls, tokens and cost from the cost records
//    and writes the result; the run stays `running` until then.
//
// A real run that needs the slot stops the agent (interrupt, then kill): the run is marked
// `preempted` and queued again for the next attempt, and the stopped attempt is not counted. When
// the activity is cancelled (the evaluation stopped) the run is `cancelled`. A refused contract
// (for example expired) gives the run its next attempt. Any other failure marks the run `failed`
// with a code. Paths, the repository, the diff and the hidden tests never reach a log, an error or
// the returned value; the measures are codes and numbers.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type {
  AgentAdapter,
  AgentTask,
  EvaluationHardwareBlock,
  EvaluationRunContract,
  ExecuteEvaluationRunInput,
  ExecuteEvaluationRunResult,
  RunContractVerifier,
  RedactedSecret,
  RunKeySpendReader,
  SecretUnwrapper,
} from '@sdlc/contracts';
import {
  loadEffectiveConfig,
  parseTenantId,
  verifyEvaluationContract,
  type EvaluationConfigurationRow,
  type PlatformDatabase,
  type TenantScope,
} from '@sdlc/core';
import {
  describeHardware,
  diffStats,
  loadConfigurations,
  loadTaskSet,
  prepareBase,
  specPathFor,
  TaskError,
  type EvalConfiguration,
  type EvalTask,
} from '@sdlc/eval';
import { Redacted } from '@sdlc/secrets';

import type { DockerClient } from '../docker/client.js';
import type { HeldRuns } from '../held.js';
import { RunnerError } from '../errors.js';
import type { SlotPool } from '../pool.js';
import { waitUntilHealthy } from '../provision.js';
import { createSandbox, ProvisioningError, teardownSandbox } from '../sandbox/lifecycle.js';
import type { RunnerSettings } from '../settings.js';
import type { GitTokenRevoker } from '../tokens.js';
import { computeRunPatch } from '../workspace/export.js';
import { CloneError, cloneForRun, type CloneInput } from '../workspace/git.js';
import { gitArgs, gitEnv } from '../workspace/proposal.js';
import { packDirectory } from '../workspace/tar.js';
import { agentContractOf, EVALUATION_AGENT_BRANCH } from './agent-contract.js';
import { driveEvaluationAgent } from './drive.js';
import { ProjectTaskError, readProjectTask } from './project-task.js';
import { scoreEvaluationRun, ScoringError } from './score.js';

const run = promisify(execFile);

export interface ExecuteEvaluationDeps {
  readonly db: PlatformDatabase;
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  readonly verifier: RunContractVerifier;
  readonly unwrapper: SecretUnwrapper;
  readonly pool: SlotPool;
  readonly held: HeldRuns;
  readonly adapter: AgentAdapter;
  readonly spendReader?: RunKeySpendReader;
  /** Revokes the clone token right after the clone. Without it the token expires by itself. */
  readonly tokenRevoker?: GitTokenRevoker;
  /** Tests only: clones the repository another way than from the Git host. */
  readonly clone?: (input: CloneInput) => Promise<string>;
  /** Tests only: reach the Agent Server another way than on the run's network. */
  readonly agentUrl?: (runId: string) => string;
  readonly now?: () => Date;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Heartbeats and such: called at each step boundary. */
  readonly onStep?: (step: string) => void;
  /** Tests only: sees the patches before scoring (to score the same change another way). */
  readonly onPatch?: (patches: { readonly basePatch: string; readonly agentPatch: string }) => void;
}

export interface ExecuteEvaluationContext {
  /** The activity's cancel signal. */
  readonly signal: AbortSignal;
}

/** Thrown at a step boundary when the run must stop (a real run needs the slot, or a cancel). */
class Stopped extends Error {
  override readonly name = 'Stopped';
}

function failureCodeOf(error: unknown): string {
  if (error instanceof ScoringError) return `scoring_${error.reason}`;
  if (error instanceof ProvisioningError) return `provisioning_${error.reason}`;
  if (error instanceof CloneError) return `clone_${error.reason}`;
  if (error instanceof TaskError) return 'task_unavailable';
  if (error instanceof RunnerError) return 'runner_error';
  return 'runner_error';
}

/** The task set's file for a configuration name: `<name>.yaml` or `<name>.yml`. */
function configurationFile(dir: string, name: string): string {
  for (const extension of ['yaml', 'yml']) {
    const file = path.join(dir, `${name}.${extension}`);
    if (fs.existsSync(file)) return file;
  }
  throw new TaskError(`configuration ${name}`, 'file is missing');
}

async function git(repo: string, home: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await run('git', gitArgs(repo, args), {
    env: gitEnv(home),
    timeout: timeoutMs,
    encoding: 'utf8',
  });
  return stdout.trim();
}

/** The pinned commit's files without `.git`: what the scoring volume gets (the install makes the repo). */
function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => path.basename(source) !== '.git',
  });
}

async function hardware(deps: ExecuteEvaluationDeps): Promise<EvaluationHardwareBlock> {
  const instance = /^[a-z][a-z0-9_.:-]{0,63}$/.test(deps.settings.instance)
    ? deps.settings.instance
    : null;
  return describeHardware({
    dockerVersion: await deps.docker.engineVersion().catch(() => 'unknown'),
    gpu: deps.settings.evaluation.gpu,
    runnerInstance: instance,
  });
}

export async function executeEvaluation(
  deps: ExecuteEvaluationDeps,
  input: ExecuteEvaluationRunInput,
  context: ExecuteEvaluationContext,
): Promise<ExecuteEvaluationRunResult> {
  const { settings } = deps;
  const runId = input.evaluationRunId;
  const scope = deps.db.forTenant(parseTenantId(input.tenantId));
  const step = (name: string) => deps.onStep?.(name);

  // Preemption is a second reason to stop, next to the activity's cancel.
  const preemption = new AbortController();
  let preempted = false;
  const signal = AbortSignal.any([context.signal, preemption.signal]);
  const checkStop = () => {
    if (signal.aborted) throw new Stopped();
  };

  if (!deps.held.hold(runId)) return { outcome: 'refused', reason: 'run_not_startable' };
  let slot;
  let workDir: string | undefined;
  let claimed = false;
  try {
    // 1. A free evaluation slot. The run is still queued while it waits.
    try {
      slot = await deps.pool.acquireEvaluation(() => {
        preempted = true;
        preemption.abort();
      }, context.signal);
    } catch (error) {
      if (error instanceof RunnerError && error.key === 'runner.slot_wait_aborted') {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'refused', reason: 'eval_slots_off' };
    }

    // 2. The signed contract, and the claim of the run.
    const stored = await scope.evaluationContracts.getForAttempt(runId, input.attempt);
    if (!stored) return { outcome: 'refused', reason: 'unknown_contract' };
    const verified = await verifyEvaluationContract(
      deps.db,
      { contract: stored.contract_json, signature: stored.signature },
      { verifier: deps.verifier, ...(deps.now ? { now: deps.now } : {}) },
    );
    if (!verified.ok) {
      // A contract that expired or was refused cannot be used again: the next attempt gets a new
      // one. A run someone else took is left alone.
      if (verified.reason !== 'run_not_startable') {
        await scope.evaluationRuns.nextAttempt(runId, input.attempt);
      }
      return { outcome: 'refused', reason: verified.reason };
    }
    const { contract } = verified;
    if (!(await scope.evaluationRuns.claim(runId, input.attempt, settings.instance))) {
      return { outcome: 'refused', reason: 'run_not_startable' };
    }
    claimed = true;
    checkStop();

    // 3. The task, the configuration, the sample repository at the contract's commit, the base.
    step('prepare');
    const evaluation = await scope.evaluations.getById(contract.evaluation_id);
    if (!evaluation) throw new TaskError('evaluation', 'not found');
    // A numbered task set is in the runner; a project's task (L07) is read from the clone below.
    let task: EvalTask | undefined;
    if (contract.task_set_kind === 'folder') {
      const set = loadTaskSet(settings.evaluation.tasksDir, [contract.task_id]);
      task = set.tasks[0]!;
      if (set.version !== contract.task_set_version) throw new TaskError('task set', 'version');
    }
    // An operator evaluation (L04) names a configuration file; an evaluation of a plan (L05,
    // QUESTIONS #475) has its resolved configurations in the database, and maybe a prompt variant:
    // a file of the repository at a recorded commit, read below with the clone token.
    let instructionsText: string | null = null;
    let variant: EvaluationConfigurationRow | undefined;
    // L09 (QUESTIONS #501): the agent's own tools, as the evaluation recorded them at its start.
    let allowedTools: readonly string[] | undefined;
    if (evaluation.config_name !== null) {
      const configuration: EvalConfiguration = loadConfigurations(
        configurationFile(settings.evaluation.configDir, evaluation.config_name),
        [contract.configuration_id],
      )[0]!;
      instructionsText = configuration.instructionsText;
    } else {
      const row = (await scope.evaluations.configurations(evaluation.id)).find(
        (c) => c.configuration_id === contract.configuration_id,
      );
      if (!row) throw new TaskError('configuration', 'not found');
      if (row.model !== contract.model) throw new TaskError('configuration', 'model');
      if (row.instructions_path !== null) variant = row;
      if (row.allowed_tools !== null) allowedTools = row.allowed_tools;
    }
    const { config } = await loadEffectiveConfig(scope.projectConfigs, contract.project_id);

    const token = (await deps.unwrapper.unwrap(new Redacted(input.wrappedGitToken))).token;
    if (!token) throw new ProvisioningError('token_unavailable');
    fs.mkdirSync(settings.workDir, { recursive: true, mode: 0o700 });
    workDir = fs.mkdtempSync(path.join(settings.workDir, 'eval-'));
    const pinned = path.join(workDir, 'pinned');
    fs.mkdirSync(pinned, { mode: 0o700 });
    let pinnedRepo: string;
    try {
      const cloneInput: CloneInput = {
        repo: contract.repo,
        baseSha: contract.base_sha,
        branch: 'evaluation',
        token,
        dir: pinned,
      };
      pinnedRepo = await (deps.clone ?? ((i) => cloneForRun(settings.git, i)))(cloneInput);
      if (variant) {
        instructionsText = await readPromptVariant(
          deps,
          settings,
          workDir,
          contract.repo,
          token,
          variant,
        );
      }
    } finally {
      // The run needs GitHub only for the clone: the token ends here, whatever happened.
      await deps.tokenRevoker?.revokeShortLivedToken(token).catch(() => undefined);
    }
    checkStop();

    let hiddenDir = task ? path.join(task.dir, 'hidden') : '';
    if (contract.task_set_kind === 'project') {
      ({ task, hiddenDir } = await readTaskOfProject(scope, contract, {
        repo: pinnedRepo,
        home: path.join(pinned, 'home'),
        workDir,
        timeoutMs: settings.git.timeoutMs,
      }));
    }
    if (!task) throw new TaskError('task', 'not found');

    const prepared = prepareBase({
      clone: pinnedRepo,
      commit: contract.base_sha,
      task,
      instructionsText,
      workDir,
    });
    // The layout `computeRunPatch` expects: `<root>/repo` and `<root>/home`.
    const diffRoot = path.join(workDir, 'diff');
    fs.mkdirSync(path.join(diffRoot, 'home'), { recursive: true, mode: 0o700 });
    const repoDir = path.join(diffRoot, 'repo');
    fs.renameSync(prepared.repoDir, repoDir);
    const home = path.join(diffRoot, 'home');
    const baseSha = await git(repoDir, home, ['rev-parse', 'HEAD'], settings.git.timeoutMs);
    await git(
      repoDir,
      home,
      ['checkout', '-q', '-b', EVALUATION_AGENT_BRANCH],
      settings.git.timeoutMs,
    );
    const specBytes = fs.readFileSync(path.join(repoDir, specPathFor(task)));
    const agentContract = agentContractOf({
      contract,
      baseSha,
      plannedFiles: task.plannedFiles,
      instructionsSha256: prepared.instructionsSha256,
      ...(allowedTools === undefined ? {} : { allowedTools }),
    });
    const agentTask: AgentTask = {
      spec: {
        path: specPathFor(task),
        commitSha: baseSha,
        contentSha256: createHash('sha256').update(specBytes).digest('hex'),
      },
      plan: { summary: task.title, plannedFiles: [...task.plannedFiles] },
    };
    checkStop();

    // The sandbox, with the base as its workspace.
    step('sandbox');
    const started = Date.now();
    const sandbox = await createSandbox(deps.docker, settings, {
      runId,
      tenantId: input.tenantId,
      image: config.sandbox.image,
      egressAllowlist: contract.egress_allowlist,
      workspaceTar: packDirectory(repoDir, settings.workspaceMaxBytes),
    });
    await waitUntilHealthy(deps, sandbox.containerId);
    checkStop();

    // 4. The agent, with the run's capped virtual key.
    step('agent');
    const virtualKey = (await deps.unwrapper.unwrap(new Redacted(input.wrappedVirtualKey))).key;
    if (!virtualKey) throw new ProvisioningError('token_unavailable');
    const driven = await driveEvaluationAgent(
      {
        docker: deps.docker,
        settings,
        adapter: deps.adapter,
        config,
        ...(deps.spendReader ? { spendReader: deps.spendReader } : {}),
        ...(deps.agentUrl ? { agentUrl: deps.agentUrl } : {}),
        ...(deps.clock ? { clock: deps.clock } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      },
      {
        contract: agentContract,
        sandbox,
        model: contract.model,
        virtualKey,
        task: agentTask,
        signal,
      },
    );
    if (driven.outcome === 'cancelled') throw new Stopped();
    if (driven.outcome === 'failed') {
      await teardownSandbox(deps.docker, runId).catch(() => undefined);
      await scope.evaluationRuns.markFailed(runId, driven.stopReason ?? 'agent_failed');
      return { outcome: 'failed', reason: driven.stopReason ?? 'agent_failed' };
    }

    // 5. The change, recomputed outside the sandbox; the sandbox goes; then the scoring.
    step('diff');
    const patch = await computeRunPatch(
      { docker: deps.docker, settings },
      { run_id: runId, base_sha: baseSha },
      diffRoot,
    );
    const agentPatch = patch.patch.toString('utf8');
    const policy = createSimplePolicyEngine({ config });
    const scope_ = policy.checkScope({
      plannedFiles: [...task.plannedFiles],
      changedFiles: patch.changedFiles,
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    await teardownSandbox(deps.docker, runId);
    checkStop();

    deps.onPatch?.({ basePatch: prepared.basePatch, agentPatch });
    step('score');
    const tree = path.join(workDir, 'tree');
    copyTree(pinnedRepo, tree);
    const score = await scoreEvaluationRun(
      { docker: deps.docker, settings },
      {
        runId,
        tenantId: input.tenantId,
        image: config.sandbox.image,
        treeDir: tree,
        hiddenDir,
        basePatch: prepared.basePatch,
        agentPatch,
        task,
      },
    );
    const stats = diffStats(agentPatch);
    return {
      outcome: 'scored',
      measures: {
        agentOutcome: driven.outcome,
        status: driven.status ?? 'failed',
        stopReason: driven.stopReason,
        seconds,
        iterations: driven.iterations,
        outOfPlanFiles: scope_.outOfScope.length,
        diffFiles: stats.files,
        diffLinesAdded: stats.added,
        diffLinesRemoved: stats.removed,
        applied: score.applied,
        ci: score.ci,
        passToPass: score.passToPass,
        failToPass: score.failToPass,
        lintFindings: score.lintFindings,
        instructionsSha256: prepared.instructionsSha256,
        hardware: await hardware(deps),
      },
    };
  } catch (error) {
    if (error instanceof Stopped || signal.aborted) {
      await teardownSandbox(deps.docker, runId).catch(() => undefined);
      if (!claimed) {
        // Stopped before the run was taken. A real run that needs the slot: the contract of this
        // attempt is not used, the run gets the next attempt (a new contract and key).
        if (!preempted) return { outcome: 'cancelled' };
        await scope.evaluationRuns.nextAttempt(runId, input.attempt);
        return { outcome: 'preempted' };
      }
      if (preempted) {
        // A real run needs the slot: the attempt is not counted, the run is queued again.
        await scope.evaluationRuns.markPreempted(runId);
        await scope.evaluationRuns.requeue(runId);
        return { outcome: 'preempted' };
      }
      await scope.evaluationRuns.markCancelled(runId, 'evaluation_stopped');
      return { outcome: 'cancelled' };
    }
    const reason = failureCodeOf(error);
    await teardownSandbox(deps.docker, runId).catch(() => undefined);
    if (claimed) await scope.evaluationRuns.markFailed(runId, reason).catch(() => false);
    return { outcome: 'failed', reason };
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    deps.held.release(runId);
    slot?.release();
  }
}

/**
 * The task of a project's task set (L07, ADR-M85 §2.10): the card at the evaluation's commit, with
 * the SHA-256 the platform approved, for the run's base commit. Anything else: `task_unavailable`.
 */
async function readTaskOfProject(
  scope: TenantScope,
  contract: EvaluationRunContract,
  where: {
    readonly repo: string;
    readonly home: string;
    readonly workDir: string;
    readonly timeoutMs: number;
  },
): Promise<{ task: EvalTask; hiddenDir: string }> {
  const stored = await scope.evaluationTasks.getByTaskId(contract.project_id, contract.task_id);
  if (!stored || contract.task_set_commit === null) throw new TaskError('task', 'not found');
  try {
    const read = await readProjectTask({
      ...where,
      taskId: contract.task_id,
      cardCommit: contract.task_set_commit,
      cardSha256: stored.card_sha256,
    });
    if (read.card.baseCommit !== contract.base_sha) throw new TaskError('task', 'base commit');
    return { task: read.task, hiddenDir: read.hiddenDir };
  } catch (error) {
    if (error instanceof ProjectTaskError) throw new TaskError('task', error.code);
    throw error;
  }
}

/**
 * The prompt variant of a plan's configuration (L05, ADR-M82 §2.3): the file at the commit the
 * evaluation recorded, from a second clone with the same single-repository token. The text must
 * have the recorded SHA-256 (else `task_unavailable`); it is a regular file inside the clone (no
 * link out of it). Never logged; the clone is removed at once.
 */
async function readPromptVariant(
  deps: ExecuteEvaluationDeps,
  settings: RunnerSettings,
  workDir: string,
  repo: string,
  token: RedactedSecret,
  row: EvaluationConfigurationRow,
): Promise<string> {
  const dir = path.join(workDir, 'prompt');
  fs.mkdirSync(dir, { mode: 0o700 });
  try {
    const clone = await (deps.clone ?? ((i) => cloneForRun(settings.git, i)))({
      repo,
      baseSha: row.instructions_commit!,
      branch: 'evaluation',
      token,
      dir,
    });
    const file = path.resolve(clone, row.instructions_path!);
    const root = fs.realpathSync(clone);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || !fs.realpathSync(file).startsWith(`${root}${path.sep}`)) {
      throw new TaskError('prompt', 'not a file of the repository');
    }
    if (stat.size > MAX_PROMPT_BYTES) throw new TaskError('prompt', 'too large');
    const text = fs.readFileSync(file, 'utf8');
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== row.instructions_sha256) {
      throw new TaskError('prompt', 'changed');
    }
    return text;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The largest prompt variant the runner reads. */
const MAX_PROMPT_BYTES = 256 * 1024;
