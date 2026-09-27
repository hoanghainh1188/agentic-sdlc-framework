// Gate G4, the facts and the run proposal (task C06, D-02 FR-03, FR-36, D-03 sections 6 and 8,
// handbook Ch.13 §13.5 Step 1, design/ADR-M33 §2.2–§2.3, QUESTIONS #108–#110).
//
// Two parts:
// - `gatherG4Facts` reads what G4 needs from outside the database, before the step's transaction
//   (no HTTP call while the intent lock is held): the head of the project's default branch (the
//   run's base commit, QUESTIONS #109), the SHA-256 of the agent's instructions file at that commit
//   (read outside the sandbox, ADR-M31 §2.5), and the models the gateway allows for the intent's
//   data class (QUESTIONS #17, #79).
// - The run proposal: the terms a G4 pass or approval is bound to (FR-17). Its hash is the G4
//   input: plan, spec, agent and its version, instructions, model, autonomy, tools, caps, allowed
//   models, base commit and data class. A change of any of them voids a G4 approval.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import {
  GitHostError,
  type DataClass,
  type GitHostAdapter,
  type ProjectConfig,
  type RepoRef,
  type RunContractAutonomy,
} from '@sdlc/contracts';

import { instructionsPath } from '../agents/check.js';
import { instructionsSha256 } from '../agents/rules.js';
import type { Intent, Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';

/** What G4 needs from outside the database (the worker wires them in; tests pass fakes). */
export interface G4Deps {
  /** The Git host of the platform's projects (GitHub in the MVP). */
  readonly gitHost: Pick<GitHostAdapter, 'getBranchHead' | 'getFileAtCommit'>;
  /**
   * The gateway's models that the data class may use under this configuration: the policy
   * engine's `allowedModels` over `ModelGateway.listModels()` (QUESTIONS #17).
   */
  readonly allowedModels: (config: ProjectConfig, dataClass: DataClass) => Promise<string[]>;
}

export interface G4Facts {
  /** Head of the project's default branch when G4 was evaluated: the run's base commit. */
  readonly baseSha: string;
  /** The configured agent's ID and the SHA-256 of its instructions file at `baseSha`. */
  readonly instructions: {
    readonly agentId: string;
    /** Null when the file does not exist at `baseSha` (G4 fails with `instructions_mismatch`). */
    readonly sha256: string | null;
  } | null;
  readonly allowedModels: readonly string[];
}

const REPO_FULL_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** The project's repository, or undefined when the stored name is not `owner/name`. */
export function projectRepoRef(project: Pick<Project, 'repo_full_name'>): RepoRef | undefined {
  const match = REPO_FULL_NAME.exec(project.repo_full_name);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

/**
 * Reads the G4 facts. Throws `GitHostError` when the Git host cannot be read (the step waits and
 * tries again); a missing instructions file is a fact (`sha256: null`), not an error.
 */
export async function gatherG4Facts(
  scope: TenantScope,
  deps: G4Deps,
  intent: Pick<Intent, 'project_id' | 'data_class'>,
): Promise<G4Facts> {
  const project = await scope.projects.getById(intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!project || !ref) throw new GitHostError('invalid_input', { field: 'repo' });
  const { config } = await loadEffectiveConfig(scope.projectConfigs, intent.project_id);
  const baseSha = await deps.gitHost.getBranchHead(ref, project.default_branch);
  const key = config.run.agent_key;
  const agent = key === null ? undefined : await scope.agents.getByKey(key);
  let instructions: G4Facts['instructions'] = null;
  if (agent) {
    let sha256: string | null;
    try {
      sha256 = instructionsSha256(
        await deps.gitHost.getFileAtCommit(ref, instructionsPath(agent), baseSha),
      );
    } catch (error) {
      if (!(error instanceof GitHostError) || !['not_found', 'not_a_file'].includes(error.code)) {
        throw error;
      }
      sha256 = null;
    }
    instructions = { agentId: agent.id, sha256 };
  }
  const allowedModels = await deps.allowedModels(config, intent.data_class);
  return { baseSha, instructions, allowedModels: [...new Set(allowedModels)].sort() };
}

/** The terms of the run that G4 passes or approves (ADR-M33 §2.3). Version 1. */
export interface RunProposal {
  readonly intentId: string;
  readonly planId: string;
  readonly planSha256: string;
  readonly specSha256: string;
  readonly agentId: string;
  readonly agentKey: string;
  readonly agentVersion: string;
  readonly instructionsSha256: string;
  /** The agent's pinned gateway model: the run's model (QUESTIONS #79). */
  readonly modelRef: string;
  readonly autonomyLevel: RunContractAutonomy;
  /** Sorted, unique. Until B09 stores plan tools: the agent's registered tools (QUESTIONS #108). */
  readonly allowedTools: readonly string[];
  /** Sorted, unique. */
  readonly allowedModels: readonly string[];
  readonly maxBudgetUsd: string;
  readonly maxIterations: number;
  readonly maxDurationMin: number;
  readonly baseSha: string;
  readonly dataClass: DataClass;
}

/** The G4 input hash: SHA-256 of the canonical JSON of the proposal (the agent key is its ID's). */
export function runProposalSha256(proposal: RunProposal): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        v: 1,
        intent_id: proposal.intentId,
        plan_id: proposal.planId,
        plan_sha256: proposal.planSha256,
        spec_sha256: proposal.specSha256,
        agent_id: proposal.agentId,
        agent_version: proposal.agentVersion,
        instructions_sha256: proposal.instructionsSha256,
        model_ref: proposal.modelRef,
        autonomy_level: proposal.autonomyLevel,
        allowed_tools: [...proposal.allowedTools],
        allowed_models: [...proposal.allowedModels],
        max_budget_usd: proposal.maxBudgetUsd,
        max_iterations: proposal.maxIterations,
        max_duration_min: proposal.maxDurationMin,
        base_sha: proposal.baseSha,
        data_class: proposal.dataClass,
      }),
      'utf8',
    )
    .digest('hex');
}

/**
 * The input hash of the last run proposal recorded for the intent (`run.proposed`), or null. A G4
 * decision from a person is bound to it (`decideGate`).
 */
export async function latestRunProposalSha256(
  scope: TenantScope,
  intentId: string,
): Promise<string | null> {
  const events = await scope.audit.listForEntity(intentId, ['run.proposed']);
  const payload = events.at(-1)?.payload as { input_sha256?: unknown } | undefined;
  return typeof payload?.input_sha256 === 'string' ? payload.input_sha256 : null;
}

/** Records the proposal (`run.proposed`) unless it is the last one recorded. True when new. */
export async function recordRunProposal(
  scope: TenantScope,
  proposal: RunProposal,
  inputSha256: string,
  at: Date,
): Promise<boolean> {
  if ((await latestRunProposalSha256(scope, proposal.intentId)) === inputSha256) return false;
  await scope.audit.append({
    action: 'run.proposed',
    actorType: 'system',
    actorId: null,
    entityId: proposal.intentId,
    occurredAt: at,
    payload: {
      input_sha256: inputSha256,
      base_sha: proposal.baseSha,
      plan_id: proposal.planId,
      agent_id: proposal.agentId,
      agent_version: proposal.agentVersion,
      instructions_sha256: proposal.instructionsSha256,
      autonomy_level: proposal.autonomyLevel,
    },
  });
  return true;
}
