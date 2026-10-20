// The check of a project's evaluation task on the server (task L07, design/ADR-M85 §2.5,
// QUESTIONS #488, #489). No agent, no model, no cost. The order:
//
// 1. wait for a free evaluation slot (free slots only; a real run that needs it stops the check);
// 2. verify the signed contract (`evaluation_task_check`) against the stored copy and the task;
// 3. clone the project's repository with the single-repository token (revoked right after), at
//    the task's base commit; read the card at its commit and check its SHA-256 and commits, read
//    the spec at its commit and check its SHA-256; read the hidden tests at the merge commit; the
//    reference solution is the diff from the base to the merge commit without the hidden tests;
// 4. score twice in the scoring containers (ADR-M81 §2.5, `NetworkMode: none` for the tests):
//    the base without a change (the hidden tests must fail), then the base with the solution (the
//    hidden tests, `pass_to_pass` and `ci` must pass).
//
// The answer is a code (`checked`, or `check_failed` with `passes_without_change`,
// `solution_fails`, `install_failed`, `card_changed`, `spec_changed`, `hidden_test_missing`). A
// real run that took the slot, a refused contract or a Docker error is handed back to the worker
// (`preempted`, `refused`, or a thrown error: the workflow calls it lost). Paths, the repository,
// the diff, the spec and the tests never reach a log, an error or the returned value.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  CheckEvaluationTaskInput,
  CheckEvaluationTaskResult,
  RunContractVerifier,
  SecretUnwrapper,
} from '@sdlc/contracts';
import {
  loadEffectiveConfig,
  parseTenantId,
  verifyTaskCheckContract,
  type PlatformDatabase,
} from '@sdlc/core';
import {
  parseTaskCard,
  prepareBase,
  TaskError,
  taskCardPath,
  taskOfCard,
  type TaskCard,
} from '@sdlc/eval';
import { Redacted } from '@sdlc/secrets';

import type { DockerClient } from '../docker/client.js';
import type { HeldRuns } from '../held.js';
import { RunnerError } from '../errors.js';
import type { SlotPool } from '../pool.js';
import { ProvisioningError, teardownSandbox } from '../sandbox/lifecycle.js';
import type { RunnerSettings } from '../settings.js';
import type { GitTokenRevoker } from '../tokens.js';
import { cloneForRun, type CloneInput } from '../workspace/git.js';
import { gitArgs, gitEnv } from '../workspace/proposal.js';
import { scoreEvaluationRun, ScoringError, type ScoreEvaluationInput } from './score.js';

const run = promisify(execFile);

/** The largest card, spec or hidden test file the check reads from Git. */
const MAX_FILE_BYTES = 1024 * 1024;

export interface CheckTaskDeps {
  readonly db: PlatformDatabase;
  readonly docker: DockerClient;
  readonly settings: RunnerSettings;
  readonly verifier: RunContractVerifier;
  readonly unwrapper: SecretUnwrapper;
  readonly pool: SlotPool;
  readonly held: HeldRuns;
  readonly tokenRevoker?: GitTokenRevoker;
  /** Tests only: clones the repository another way than from the Git host. */
  readonly clone?: (input: CloneInput) => Promise<string>;
  /** Tests only: scores another way than in the scoring containers. */
  readonly score?: typeof scoreEvaluationRun;
  readonly now?: () => Date;
  /** Heartbeats: called at each step boundary. */
  readonly onStep?: (step: string) => void;
}

/** A failure of the task itself: the check ends with this code. */
class CheckFailed extends Error {
  override readonly name = 'CheckFailed';
  constructor(
    readonly code: Extract<CheckEvaluationTaskResult, { outcome: 'check_failed' }>['code'],
  ) {
    super(code);
  }
}

class Stopped extends Error {
  override readonly name = 'Stopped';
}

async function gitText(
  repo: string,
  home: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await run('git', gitArgs(repo, args), {
    env: gitEnv(home),
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** A file of the repository at a commit, as bytes; undefined when it does not exist there. */
async function fileAt(
  repo: string,
  home: string,
  commit: string,
  file: string,
  timeoutMs: number,
): Promise<Buffer | undefined> {
  try {
    const { stdout } = await run('git', gitArgs(repo, ['show', `${commit}:${file}`]), {
      env: gitEnv(home),
      timeout: timeoutMs,
      encoding: 'buffer',
      maxBuffer: MAX_FILE_BYTES,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** The pinned commit's files without `.git`: what the scoring volume gets. */
function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => path.basename(source) !== '.git',
  });
}

export async function checkTask(
  deps: CheckTaskDeps,
  input: CheckEvaluationTaskInput,
  context: { readonly signal: AbortSignal },
): Promise<CheckEvaluationTaskResult> {
  const { settings } = deps;
  const id = input.evaluationTaskId;
  const scope = deps.db.forTenant(parseTenantId(input.tenantId));
  const step = (name: string) => deps.onStep?.(name);
  const timeoutMs = settings.git.timeoutMs;

  const preemption = new AbortController();
  const signal = AbortSignal.any([context.signal, preemption.signal]);
  const checkStop = () => {
    if (signal.aborted) throw new Stopped();
  };

  // The task's ID names the Docker objects of its scoring, like a run's ID.
  if (!deps.held.hold(id)) return { outcome: 'refused', reason: 'run_not_startable' };
  let slot;
  let workDir: string | undefined;
  try {
    // 1. A free evaluation slot.
    try {
      slot = await deps.pool.acquireEvaluation(() => preemption.abort(), context.signal);
    } catch (error) {
      if (error instanceof RunnerError && error.key === 'runner.slot_wait_aborted') {
        return { outcome: 'preempted' };
      }
      return { outcome: 'refused', reason: 'eval_slots_off' };
    }

    // 2. The signed contract.
    const stored = await scope.evaluationTaskCheckContracts.get(
      id,
      input.cardSha256,
      input.attempt,
    );
    if (!stored) return { outcome: 'refused', reason: 'unknown_contract' };
    const verified = await verifyTaskCheckContract(
      deps.db,
      { contract: stored.contract_json, signature: stored.signature },
      { verifier: deps.verifier, ...(deps.now ? { now: deps.now } : {}) },
    );
    if (!verified.ok) return { outcome: 'refused', reason: verified.reason };
    const { contract } = verified;
    checkStop();

    // 3. The repository at the base commit; the card, the spec, the hidden tests, the solution.
    step('prepare');
    const { config } = await loadEffectiveConfig(scope.projectConfigs, contract.project_id);
    const token = (await deps.unwrapper.unwrap(new Redacted(input.wrappedGitToken))).token;
    if (!token) throw new ProvisioningError('token_unavailable');
    fs.mkdirSync(settings.workDir, { recursive: true, mode: 0o700 });
    workDir = fs.mkdtempSync(path.join(settings.workDir, 'check-'));
    const pinned = path.join(workDir, 'pinned');
    fs.mkdirSync(pinned, { mode: 0o700 });
    let repo: string;
    try {
      repo = await (deps.clone ?? ((i) => cloneForRun(settings.git, i)))({
        repo: contract.repo,
        baseSha: contract.base_sha,
        branch: 'evaluation',
        token,
        dir: pinned,
      });
    } finally {
      await deps.tokenRevoker?.revokeShortLivedToken(token).catch(() => undefined);
    }
    const home = path.join(pinned, 'home');
    checkStop();

    const cardBytes = await fileAt(
      repo,
      home,
      contract.card_commit,
      taskCardPath(contract.task_id),
      timeoutMs,
    );
    if (!cardBytes || sha256(cardBytes) !== contract.card_sha256)
      throw new CheckFailed('card_changed');
    let card: TaskCard;
    try {
      card = parseTaskCard(cardBytes.toString('utf8'), taskCardPath(contract.task_id));
    } catch {
      throw new CheckFailed('card_changed');
    }
    if (card.baseCommit !== contract.base_sha || card.mergeCommit !== contract.merge_sha) {
      throw new CheckFailed('card_changed');
    }
    const spec = await fileAt(repo, home, card.spec.commit, card.spec.path, timeoutMs);
    if (!spec || sha256(spec) !== card.spec.sha256) throw new CheckFailed('spec_changed');

    const hiddenDir = path.join(workDir, 'hidden');
    fs.mkdirSync(hiddenDir, { mode: 0o700 });
    for (const file of card.hiddenTests) {
      const bytes = await fileAt(repo, home, card.mergeCommit, file, timeoutMs);
      if (!bytes) throw new CheckFailed('hidden_test_missing');
      const target = path.resolve(hiddenDir, file);
      if (!target.startsWith(`${hiddenDir}${path.sep}`)) throw new CheckFailed('card_changed');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, bytes, { mode: 0o600 });
    }
    const solution = await gitText(
      repo,
      home,
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        card.baseCommit,
        card.mergeCommit,
        '--',
        '.',
        ...card.hiddenTests.map((file) => `:(exclude,literal)${file}`),
      ],
      timeoutMs,
    );

    const task = taskOfCard(card, spec.toString('utf8'));
    const prepared = prepareBase({
      clone: repo,
      commit: card.baseCommit,
      task,
      instructionsText: null,
      workDir,
    });
    const tree = path.join(workDir, 'tree');
    copyTree(repo, tree);
    checkStop();

    // 4. Two scorings, one after the other (each removes the Docker objects of the last).
    const score = deps.score ?? scoreEvaluationRun;
    const scoreInput = (agentPatch: string): ScoreEvaluationInput => ({
      runId: id,
      tenantId: input.tenantId,
      image: config.sandbox.image,
      treeDir: tree,
      hiddenDir,
      basePatch: prepared.basePatch,
      agentPatch,
      task,
    });
    step('score_base');
    const base = await score({ docker: deps.docker, settings }, scoreInput(''));
    checkStop();
    if (!base.applied) throw new CheckFailed('solution_fails');
    if (base.failToPass) throw new CheckFailed('passes_without_change');
    step('score_solution');
    const solved = await score({ docker: deps.docker, settings }, scoreInput(solution));
    if (!(solved.applied && solved.failToPass && solved.passToPass && solved.ci)) {
      throw new CheckFailed('solution_fails');
    }
    return { outcome: 'checked' };
  } catch (error) {
    if (error instanceof Stopped || signal.aborted) {
      await teardownSandbox(deps.docker, id).catch(() => undefined);
      return { outcome: 'preempted' };
    }
    if (error instanceof CheckFailed) return { outcome: 'check_failed', code: error.code };
    if (
      error instanceof ScoringError &&
      (error.reason === 'install_failed' || error.reason === 'install_timeout')
    ) {
      return { outcome: 'check_failed', code: 'install_failed' };
    }
    if (error instanceof TaskError) return { outcome: 'check_failed', code: 'card_changed' };
    await teardownSandbox(deps.docker, id).catch(() => undefined);
    // Anything else (Docker, Git host, OpenBao): the worker hands the check over again.
    throw error;
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    deps.held.release(id);
    slot?.release();
  }
}
