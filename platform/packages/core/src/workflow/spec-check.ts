// The spec re-check before G3 and before the run (task B08, D-08 B08 AC2, D-02 FR-02, D-03
// section 6 "spec hash changed after G2 → back to G2", design/ADR-M39 §2.4, QUESTIONS #160, #161,
// #163; scenario N4 of D-09).
//
// The spec of an intent is the file at the head of the project's default branch (QUESTIONS #160):
// G4 starts the run from that head, so the agent reads that version. Whenever the intent waits at
// G2, G3 or G4, the step reads the head and the file before its transaction (`gatherSpecFacts`; no
// HTTP call under the intent lock) and then, under the lock (`checkSpec`):
// - the content changed at head → the platform links it as a new spec version (`head_changed`);
//   at G3 or G4 the intent goes back to G2 (notice `spec_changed`). The approvals of G2 up to the
//   gate it left are voided (FR-17); the matrix decides whether G2 passes again
//   (HOTL at Low risk, with its block window) or waits for a person (QUESTIONS #161).
// - a person linked a new spec after G2 passed (the latest spec is not the one G2 passed) → back
//   to G2, the same way.
// - the file cannot be read at head (removed, renamed, not a file, too large, not UTF-8) → back to
//   G2 (notice `spec_unavailable`, once per spec version and cause), where the intent waits until
//   a person links a spec that can be read. It never passes.
// - the Git host cannot be read → the gate is held and the step tries again
//   (`git_host_unavailable`); it never passes on a failed read.
// A held gate (`hold`) refuses only the advance: rejections, requests for changes, blocks of a
// passed gate and the gate's overdue escalation are still handled (code review of B08).
// Sending the intent back is never frozen: it stops work, it does not advance (ADR-M28 §2.7).
import {
  GitHostError,
  type GateCode,
  type IntentStepResult,
  type PolicyEngine,
  type ProjectRole,
} from '@sdlc/contracts';

import type { Intent, SpecRef } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { IntentNoticeKind } from '../db/repositories/intent-notices.js';
import type { Registry } from '../registry/registry.js';
import type { SpecGitHost } from '../specs/link.js';
import { readSpec, type SpecRead } from '../specs/read.js';
import { passedInput } from './g4.js';
import { projectRepoRef } from './g4-proposal.js';
import { closeGateOverdue } from './overdue.js';

/** The gates at which the step re-checks the spec. */
export const SPEC_CHECK_GATES = ['G2', 'G3', 'G4'] as const satisfies readonly GateCode[];
type SpecCheckGate = (typeof SPEC_CHECK_GATES)[number];

export function isSpecCheckGate(gate: GateCode | null): gate is SpecCheckGate {
  return gate !== null && (SPEC_CHECK_GATES as readonly string[]).includes(gate);
}

/** What the step read from the Git host for the spec check. */
export interface SpecFacts {
  /** Head of the project's default branch; G4 uses the same commit as the run's base. */
  readonly headSha: string;
  /** The latest linked spec and the file at `headSha`; null when no spec is linked yet. */
  readonly spec: { readonly specRefId: string; readonly read: SpecRead } | null;
}

/**
 * Reads the head of the default branch and the latest spec's file there. Throws `GitHostError`
 * when the Git host cannot be read (the step waits). Call it outside the step's transaction.
 */
export async function gatherSpecFacts(
  scope: TenantScope,
  deps: SpecGitHost,
  intent: Pick<Intent, 'id' | 'project_id'>,
): Promise<SpecFacts> {
  const project = await scope.projects.getById(intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!project || !ref) throw new GitHostError('invalid_input', { field: 'repo' });
  const headSha = await deps.gitHost.getBranchHead(ref, project.default_branch);
  const latest = await scope.specRefs.latest(intent.id);
  if (!latest) return { headSha, spec: null };
  return {
    headSha,
    spec: { specRefId: latest.id, read: await readSpec(deps.gitHost, ref, latest.path, headSha) },
  };
}

/** Delay before the step reads the Git host again after it could not. */
const GIT_HOST_RETRY_MS = 60_000;

/** The gate may not advance; the step still handles everything that does not advance it. */
export interface SpecHold {
  readonly reason: 'spec_unavailable' | 'git_host_unavailable';
  readonly wakeInMs?: number;
}

export type SpecCheckOutcome =
  | { readonly kind: 'result'; readonly result: IntentStepResult }
  | { readonly kind: 'hold'; readonly hold: SpecHold };

const moved: SpecCheckOutcome = { kind: 'result', result: { outcome: 'moved' } };

/**
 * Applies the spec check under the intent lock. `facts` is `git_host_unavailable` when the Git
 * host could not be read. Returns null when the spec is in order (the step goes on), a result
 * when the check moved the intent, or a hold.
 */
export async function checkSpec(
  tx: TenantScope,
  registry: Registry,
  policy: PolicyEngine,
  intent: Intent,
  facts: SpecFacts | 'git_host_unavailable',
): Promise<SpecCheckOutcome | null> {
  const gate = intent.current_gate;
  if (intent.status !== 'in_gate' || !isSpecCheckGate(gate)) return null;
  if (facts === 'git_host_unavailable') {
    return { kind: 'hold', hold: { reason: 'git_host_unavailable', wakeInMs: GIT_HOST_RETRY_MS } };
  }
  const latest = await tx.specRefs.latest(intent.id);
  if (!latest) return null; // G2 waits for a spec (`input_missing`); G4 fails `spec_changed`.
  // A spec was linked after the facts were read: read again.
  if (facts.spec?.specRefId !== latest.id) return moved;
  const { read } = facts.spec;

  if (read.kind === 'unreadable') {
    const first = await recordUnavailable(tx, intent, latest, read.cause, facts.headSha);
    if (gate !== 'G2') {
      // One notice per spec version and cause, also when the file comes and goes.
      await backToG2(tx, registry, policy, intent, gate, first ? 'spec_unavailable' : null);
      return moved;
    }
    if (first) await notice(tx, policy, intent, 'spec_unavailable');
    return { kind: 'hold', hold: { reason: 'spec_unavailable' } };
  }

  if (read.sha256 !== latest.content_sha256) {
    await tx.specRefs.link(intent.id, {
      actorType: 'system',
      actorId: null,
      path: latest.path,
      commitSha: facts.headSha,
      contentSha256: read.sha256,
      sourceTool: latest.source_tool,
      cause: 'head_changed',
    });
    if (gate === 'G2') await notice(tx, policy, intent, 'spec_changed');
    else await backToG2(tx, registry, policy, intent, gate, 'spec_changed');
    return moved;
  }

  // A person linked another spec after G2 passed (or G2's pass was voided): G2 decides again.
  if (gate !== 'G2' && (await passedInput(tx, intent.id, 'G2')) !== latest.content_sha256) {
    await backToG2(tx, registry, policy, intent, gate, 'spec_changed');
    return moved;
  }
  return null;
}

/** Writes `spec.unavailable` once per spec version and cause; true when written now. */
async function recordUnavailable(
  tx: TenantScope,
  intent: Intent,
  spec: SpecRef,
  cause: string,
  headSha: string,
): Promise<boolean> {
  const earlier = await tx.audit.listForEntity(intent.id, ['spec.unavailable']);
  const seen = earlier.some((row) => {
    const payload = row.payload as { spec_ref_id?: unknown; cause?: unknown };
    return payload.spec_ref_id === spec.id && payload.cause === cause;
  });
  if (seen) return false;
  await tx.audit.append({
    action: 'spec.unavailable',
    actorType: 'system',
    actorId: null,
    entityId: intent.id,
    payload: { spec_ref_id: spec.id, cause, head_sha: headSha },
  });
  return true;
}

async function backToG2(
  tx: TenantScope,
  registry: Registry,
  policy: PolicyEngine,
  intent: Intent,
  gate: Exclude<SpecCheckGate, 'G2'>,
  /** The notice of the move; null: none (already told). */
  kind: Extract<IntentNoticeKind, 'spec_changed' | 'spec_unavailable'> | null,
): Promise<void> {
  await closeGateOverdue(tx, registry, intent.id, gate);
  // The gates from G2 on are decided again: their approvals no longer count (FR-17), so they are
  // voided, and the same people may approve again (like C07's return to G3).
  for (const redo of SPEC_CHECK_GATES.slice(0, SPEC_CHECK_GATES.indexOf(gate) + 1)) {
    await registry.voidApprovals(tx, {
      intentId: intent.id,
      gate: redo,
      reasonCode: 'input_mismatch',
    });
  }
  const updated = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: gate },
    to: { status: 'in_gate', currentGate: 'G2' },
    at: registry.now(),
  });
  if (updated && kind !== null) await notice(tx, policy, updated, kind, gate);
}

async function notice(
  tx: TenantScope,
  policy: PolicyEngine,
  intent: Intent,
  kind: Extract<IntentNoticeKind, 'spec_changed' | 'spec_unavailable'>,
  previousGate: GateCode = 'G2',
): Promise<void> {
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: 'in_gate',
    gate: 'G2',
    previousGate,
    decisionId: null,
    audienceRoles: await g2Actors(tx, policy, intent),
  });
}

/** The roles that act at G2: the gate's approvers or the people it tells. Never `viewer`. */
async function g2Actors(
  tx: TenantScope,
  policy: PolicyEngine,
  intent: Intent,
): Promise<ProjectRole[]> {
  const plan = await tx.plans.latest(intent.id);
  const oversight = policy.oversightMode({
    gate: 'G2',
    riskTier: intent.risk_tier,
    changeFlags: plan?.change_flags ?? [],
  });
  return oversight.roles.filter((role) => role !== 'viewer');
}
