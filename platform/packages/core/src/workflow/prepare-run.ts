// Preparing a run after G4 (task C06, D-08 C06 AC1, D-02 FR-31, FR-33, FR-36, FR-50, D-03
// sections 8 and 8.2, design/ADR-M33 §2.5, QUESTIONS #44, #79, #112).
//
// The worker calls `prepareRun` just before it hands the run to the runner (session 2: the
// Temporal task queue `sdlc-runner`). In order:
// 1. read the G4 facts again (base commit, instructions file, allowed models) and, under the
//    intent lock, run the G4 checks again: the proposal must still be ready and still be the one
//    G4 passed or Person A approved (FR-17: an approval is re-checked just before the action);
// 2. issue and sign the Run Contract (`issueRunContract`, ADR-M22) from that proposal;
// 3. an overdue recertification is a warning, not a block (FR-36): the audit event
//    `agent.recertification_overdue` with the run and one notice that mentions the agent's owner
//    (ADR-M31 §2.7);
// 4. issue the run's LiteLLM virtual key, capped by the Cost Controller at the smallest of the run,
//    intent and tenant remainders (ADR-M24); a used-up budget cancels the run (`budget_exceeded`);
// 5. issue the run's single-repository GitHub token (read: the runner clones; C08 pushes with its
//    own token) and hand both secrets over as single-use OpenBao wrapping tokens that live as long
//    as the contract is valid (QUESTIONS #44, #112). Only the wrapping tokens and IDs travel on:
//    no secret, no client data in the Temporal history (ADR-M30 §2.1).
// If anything fails after the contract, the key is revoked and the run is cancelled
// (`prepare_failed`), so no run waits in `queued` with a live key.
import {
  GitHostError,
  type GitHostAdapter,
  type RedactedSecret,
  type RunContractSigner,
  type SecretWrapper,
} from '@sdlc/contracts';

import { CostError } from '../cost/errors.js';
import type { CostController } from '../cost/controller.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { Registry } from '../registry/registry.js';
import { issueRunContract } from '../run-contract/issue.js';
import { gatherG4Facts, projectRepoRef, type G4Deps, type RunProposal } from './g4-proposal.js';
import { evaluateG4, g4Decided } from './g4.js';
import { isFinalRun, roundRuns } from './run-round.js';

export interface PrepareRunDeps {
  readonly registry: Registry;
  readonly g4: G4Deps;
  readonly signer: RunContractSigner;
  readonly costController: Pick<CostController, 'issueRunKey' | 'endRun'>;
  readonly gitHost: Pick<GitHostAdapter, 'issueShortLivedToken'>;
  readonly wrapper: SecretWrapper;
  /** Services the sandbox may reach, as `alias:port` (deployment settings, ADR-M25 §2.2). */
  readonly egressAllowlist: readonly string[];
}

export type PrepareRunRefusal =
  /** The intent is not at G4 (moved, rejected, blocked) or unknown. */
  | 'not_at_g4'
  /** A G4 check does not pass any more, or the intent must wait (block window, freeze). */
  | 'not_ready'
  /** The proposal changed since G4 passed or was approved: G4 decides again. */
  | 'not_decided'
  /** The Cost Controller refused the run's key: the intent or tenant budget is used up. */
  | 'budget_exceeded'
  /**
   * A run of this round is already under way (session 2, ADR-M33 §2.6): a retried or concurrent
   * call never issues a second run, contract, token or key.
   */
  | 'run_exists';

export interface PreparedRun {
  readonly runId: string;
  readonly attempt: number;
  /** The agent's pinned gateway model: the model the runner asks for (QUESTIONS #79). */
  readonly modelRef: string;
  readonly agentKey: string;
  /** Gateway key ID (not the key): the caller revokes it when the run ends (`endRun`). */
  readonly keyId: string;
  readonly keyIssuedAt: Date;
  /** Single-use wrapping token around `{ token }`, the run's GitHub token. */
  readonly wrappedGitToken: RedactedSecret;
  /** Single-use wrapping token around `{ key }`, the run's LiteLLM virtual key. */
  readonly wrappedVirtualKey: RedactedSecret;
  readonly warnings: readonly 'recertification_overdue'[];
}

export type PrepareRunResult =
  | { readonly ok: true; readonly run: PreparedRun }
  | { readonly ok: false; readonly reason: PrepareRunRefusal };

/** Wrapping tokens live as long as the contract is valid (ADR-M25 §2.11). */
const SECONDS_PER_MINUTE = 60;

interface Checked {
  readonly inputSha256: string;
  readonly proposal: RunProposal;
  readonly triggeredBy: string | null;
  readonly agent: { readonly id: string; readonly key: string; readonly tools: readonly string[] };
  readonly ownerWarning: boolean;
  readonly validityMinutes: number;
}

export async function prepareRun(
  scope: TenantScope,
  deps: PrepareRunDeps,
  intentId: string,
): Promise<PrepareRunResult> {
  const peek = await scope.intents.getById(intentId);
  if (!peek || !isAtG4(peek)) return { ok: false, reason: 'not_at_g4' };
  const facts = await gatherG4Facts(scope, deps.g4, peek);

  const checked = await scope.transaction(async (tx): Promise<Checked | PrepareRunRefusal> => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (!intent || !isAtG4(intent)) return 'not_at_g4';
    if ((await roundRuns(tx, intent)).some((r) => !isFinalRun(r.status))) return 'run_exists';
    const policy = await deps.registry.policyFor(tx, intent.project_id);
    const ready = await evaluateG4(tx, deps.registry, policy, intent, facts);
    if (ready.kind !== 'ready') return 'not_ready';
    const decided = await g4Decided(tx, deps.registry, policy, intent, ready.inputSha256);
    if (!decided.decided) return 'not_decided';
    return {
      inputSha256: ready.inputSha256,
      proposal: ready.proposal,
      triggeredBy: decided.approverId,
      agent: ready.agent.agent,
      ownerWarning: ready.agent.warnings.includes('recertification_overdue'),
      validityMinutes: policy.config.run.contract_validity_minutes,
    };
  });
  if (typeof checked === 'string') return { ok: false, reason: checked };
  const { proposal } = checked;

  const issued = await issueRunContract(
    scope,
    {
      intentId,
      planId: proposal.planId,
      baseSha: proposal.baseSha,
      agent: {
        id: proposal.agentId,
        version: proposal.agentVersion,
        instructionsSha256: proposal.instructionsSha256,
        tools: checked.agent.tools,
      },
      // B09: the proposal's tools are already the agent's tools that the plan lists.
      planTools: proposal.allowedTools,
      autonomyLevel: proposal.autonomyLevel,
      maxBudgetUsd: proposal.maxBudgetUsd,
      maxIterations: proposal.maxIterations,
      maxDurationMin: proposal.maxDurationMin,
      allowedModels: proposal.allowedModels,
      egressAllowlist: deps.egressAllowlist,
      triggeredBy: checked.triggeredBy,
    },
    { signer: deps.signer, now: () => deps.registry.now() },
  );
  const runId = issued.run.id;
  // The contract was signed outside the lock. Before any secret is issued, check again under the
  // lock that this proposal is still the decided one (code review of session 1): a block, a freeze
  // or a new proposal in between cancels the run.
  const still = await scope.transaction(async (tx) => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (!intent || !isAtG4(intent)) return false;
    const policy = await deps.registry.policyFor(tx, intent.project_id);
    const again = await evaluateG4(tx, deps.registry, policy, intent, facts);
    if (again.kind !== 'ready' || again.inputSha256 !== checked.inputSha256) return false;
    return (await g4Decided(tx, deps.registry, policy, intent, again.inputSha256)).decided;
  });
  if (!still) {
    await cancel(scope, deps.registry, runId, 'not_decided');
    return { ok: false, reason: 'not_decided' };
  }
  if (checked.ownerWarning) await warnOwner(scope, deps.registry, intentId, checked.agent, runId);

  let key;
  const keyIssuedAt = deps.registry.now();
  try {
    key = await deps.costController.issueRunKey({
      tenantId: scope.tenantId,
      runId,
      gate: 'G4',
      agent: checked.agent.key,
    });
  } catch (error) {
    if (
      error instanceof CostError &&
      (error.code === 'intent_budget_exhausted' || error.code === 'tenant_budget_exhausted')
    ) {
      await cancel(scope, deps.registry, runId, 'budget_exceeded');
      return { ok: false, reason: 'budget_exceeded' };
    }
    await cancel(scope, deps.registry, runId, 'prepare_failed');
    throw error;
  }

  try {
    // C07 (ADR-M34 §2.6): the key's cap and which budget set it (run, intent or tenant), so G5 and
    // the runner's spend check can be traced. The key and its ID never go into run events.
    await scope.runEvents.append(runId, 'key_issued', {
      max_budget_usd: key.maxBudgetUsd,
      limited_by: key.limitedBy,
    });
    const project = await scope.projects.getById(peek.project_id);
    const ref = project ? projectRepoRef(project) : undefined;
    if (!ref) throw new GitHostError('invalid_input', { field: 'repo' });
    const token = await deps.gitHost.issueShortLivedToken(ref, {
      permissions: { contents: 'read' },
    });
    const ttlSeconds = checked.validityMinutes * SECONDS_PER_MINUTE;
    const wrappedGitToken = await deps.wrapper.wrap({ token: token.token }, { ttlSeconds });
    const wrappedVirtualKey = await deps.wrapper.wrap({ key: key.key.key }, { ttlSeconds });
    return {
      ok: true,
      run: {
        runId,
        attempt: issued.run.attempt,
        modelRef: proposal.modelRef,
        agentKey: checked.agent.key,
        keyId: key.key.keyId,
        keyIssuedAt,
        wrappedGitToken,
        wrappedVirtualKey,
        warnings: checked.ownerWarning ? ['recertification_overdue'] : [],
      },
    };
  } catch (error) {
    await deps.costController.endRun({ keyId: key.key.keyId, syncFrom: keyIssuedAt });
    await cancel(scope, deps.registry, runId, 'prepare_failed');
    throw error;
  }
}

function isAtG4(intent: { readonly status: string; readonly current_gate: string | null }) {
  return (
    intent.current_gate === 'G4' && (intent.status === 'in_gate' || intent.status === 'running')
  );
}

/** FR-36: the run is not blocked; the owner is told, and the audit log records it with the run. */
async function warnOwner(
  scope: TenantScope,
  registry: Registry,
  intentId: string,
  agent: Checked['agent'],
  runId: string,
): Promise<void> {
  await scope.transaction(async (tx) => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (!intent) return;
    await tx.audit.append({
      action: 'agent.recertification_overdue',
      actorType: 'system',
      actorId: null,
      entityId: agent.id,
      occurredAt: registry.now(),
      payload: { agent_key: agent.key, run_id: runId },
    });
    await tx.intentNotices.record({
      intentId,
      kind: 'agent_recertification_due',
      status: intent.status,
      gate: intent.current_gate,
      previousGate: null,
      decisionId: null,
      audienceRoles: [],
      agentId: agent.id,
    });
  });
}

/** Ends a run that never started; `stopReason` is a code. */
async function cancel(scope: TenantScope, registry: Registry, runId: string, stopReason: string) {
  const now = registry.now();
  await scope.runs.transition(runId, {
    from: ['queued'],
    to: 'cancelled',
    now,
    stopReason,
    finishedAt: now,
  });
}
