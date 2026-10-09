// One handler for gate decisions from people: the API (task B03) and, later, comment commands
// (B06) and the workflow signal (B07) (ADR-M26 section 2.4, QUESTIONS.md #64).
// It records the decision only. Moving the intent to the next gate is the workflow's job (B07,
// ADR-M30): the caller wakes the intent's workflow after the commit.
import type { EventSource, GateReasonCode, UserId } from '@sdlc/contracts';

import type { GateDecisionRow, Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { normalizeScope, type ApprovalScope } from '../registry/approval-binding.js';
import type { HumanDecision } from '../registry/decision-rules.js';
import type { Registry } from '../registry/registry.js';
import { specWithoutCriteria } from '../workflow/g2-criteria.js';
import { refusedPlanHashes, returnedFromG5 } from '../workflow/g5-scope.js';
import { RegistryError } from '../registry/errors.js';
import { gatherG6Facts } from '../workflow/g6-ci.js';
import { g7Producers } from '../workflow/g7-facts.js';
import { g8Producers } from '../workflow/g8-facts.js';
import { contextOf } from '../workflow/g6-verify.js';
import { isPassableGate, openBlockWindow } from '../workflow/hotl.js';
import { waitedSeconds } from '../workflow/waited.js';
import { projectAccess } from './access.js';
import { CommandError } from './errors.js';
import { gateInputSha256, isDecidableGate } from './gate-input.js';

/** Decisions a person may send as a command (D-08 B03 AC3, B06 AC2). */
export const COMMAND_DECISIONS = [
  'approve',
  'reject',
  'request_changes',
] as const satisfies readonly HumanDecision[];
export type CommandDecision = (typeof COMMAND_DECISIONS)[number];

export interface GateCommand {
  readonly intent: Intent;
  readonly gate: string;
  readonly decision: CommandDecision;
  readonly actorId: UserId;
  readonly reasonCode?: GateReasonCode | null;
  readonly reasonRef?: string | null;
  readonly scope?: ApprovalScope | null;
  readonly source: 'cli' | 'github_comment' | 'github_review';
  readonly eventSource?: EventSource | null;
}

/**
 * Checks that the actor can see the intent's project (no role → `intent_not_found`, so an
 * outsider learns nothing), binds the decision to the gate's input and records it through the
 * registry, which resolves the oversight mode and checks the approver with the policy engine.
 * At G1 and G2 there is no produced change yet, so the producer list is empty (QUESTIONS.md #64).
 * At G3 (B09, ADR-M40 §2.3) the people who submitted the intent's plan files produced the plan:
 * they never approve it (FR-11). At G4 the run does not exist yet. At G5 (C07) the person who allowed the run (`triggered_by`,
 * the G4 approver) produced its changes with the agent and never decides them (FR-11).
 */
export async function decideGate(
  registry: Registry,
  scope: TenantScope,
  command: GateCommand,
): Promise<GateDecisionRow> {
  const { intent } = command;
  const access = await projectAccess(scope, intent.project_id, command.actorId);
  if (access.roles.length === 0) {
    throw new CommandError('intent_not_found', `intent ${intent.code} not found`);
  }
  if (!isDecidableGate(command.gate)) {
    throw new CommandError('gate_not_supported', `${command.gate} cannot be decided by a command`);
  }
  const gate = command.gate;
  // E01 (QUESTIONS #175): G7 approvals are GitHub reviews of the pull request's head.
  if (gate === 'G7' && command.decision === 'approve') {
    throw new CommandError('g7_use_pr_review', `${intent.code}: approve G7 with a PR review`);
  }
  // E01 PR 2 (QUESTIONS #190): a request for changes at G7 starts a new run that reads the
  // feedback of the review or comment that recorded it, by its ID; the API and the CLI have no
  // text the runner may read, so they never send one.
  if (gate === 'G7' && command.decision === 'request_changes' && command.source === 'cli') {
    throw new CommandError(
      'g7_feedback_on_git_host',
      `${intent.code}: request changes at G7 with a PR review or a comment`,
    );
  }
  // D3 (B07 session 2): the gate advance at G1–G3 has no scope, nor the run start at G4 (C06), so an approval with one is refused
  // here instead of being recorded and then voided (`scope_mismatch`, which stays as a safeguard).
  if (command.decision === 'approve' && normalizeScope(command.scope) !== null) {
    throw new CommandError('scope_not_allowed', `${gate} approvals take no scope`);
  }
  // The workflow counts decisions only for the gate the intent waits at (B07, ADR-M30 §2.4), with
  // one exception: within its HOTL block window, a gate the platform passed may still be rejected
  // or sent back although the intent waits at a later gate (QUESTIONS #88, ADR-M30 §2.4b).
  // Checked on the intent read under its lock, in the transaction of the decision: the workflow
  // cannot move the intent between the check and the record.
  return scope.transaction(async (tx) => {
    const current = await tx.intents.lockAndGet(intent.id);
    if (!current) throw new CommandError('intent_not_found', `intent ${intent.code} not found`);
    const now = registry.now();
    const atGate = current.status === 'in_gate' && current.current_gate === gate;
    // C13 (ADR-M64 §2.2): after an L1 proposal the intent is paused at G4; Person A ends it with a
    // G4 rejection once the proposal is taken forward. No other decision, no other paused case.
    const endsProposal = await rejectsProposal(tx, current, gate, command);
    if (
      !atGate &&
      !endsProposal &&
      !(await mayBlockPassedGate(registry, tx, current, gate, command, now))
    ) {
      throw new CommandError(
        'gate_not_current',
        `${current.code} is not waiting at ${gate} (${current.status}, ${String(current.current_gate)})`,
      );
    }
    const inputSha256 = await gateInputSha256(tx, current, gate);
    const producers = await producersOf(tx, current, gate);
    // E01 (QUESTIONS #179): a producer never decides G7, a request for changes included; E03:
    // nor G8 (FR-11, ADR-M49 §2.3).
    if ((gate === 'G7' || gate === 'G8') && producers.includes(command.actorId)) {
      throw new RegistryError(
        'decision_not_allowed',
        `${gate} ${command.decision}: producer`,
        'producer',
      );
    }
    // S01 (D-02 §6.2, QUESTIONS #292): G2 never passes without acceptance criteria.
    if (
      gate === 'G2' &&
      command.decision === 'approve' &&
      (await specWithoutCriteria(tx, current.id))
    ) {
      throw new CommandError(
        'spec_unclear',
        `${current.code}: the spec has no acceptance criteria`,
      );
    }
    // C07 (QUESTIONS #131): after a run went outside its plan, G3 is HITL and needs a new plan.
    const returned = gate === 'G3' && (await returnedFromG5(tx, current.id));
    if (
      returned &&
      command.decision === 'approve' &&
      (await refusedPlanHashes(tx, current.id)).has(inputSha256)
    ) {
      throw new CommandError('plan_refused', `${current.code}: a run went outside this plan`);
    }
    return registry.decide(tx, {
      intentId: current.id,
      gate: gate,
      decision: command.decision,
      actor: { type: 'human', id: command.actorId },
      producers,
      inputSha256,
      reasonCode: command.reasonCode ?? null,
      reasonRef: command.reasonRef ?? null,
      ...(command.decision === 'approve' ? { scope: command.scope ?? null } : {}),
      // FR-12: the time the gate waited for this person; none for a block of a passed gate.
      waitedSeconds: atGate ? waitedSeconds(current, now) : null,
      source: command.source,
      eventSource: command.eventSource ?? null,
      ...(returned ? { context: { returnedFromG5: true } } : {}),
      // C08 PR 2: G6's oversight depends on the findings G6 read (QUESTIONS #157).
      ...(gate === 'G6' ? { context: await g6Context(tx, current.id) } : {}),
      // E03 (QUESTIONS #220): every G8 is a production release in the MVP.
      ...(gate === 'G8' ? { context: { environment: 'production' as const } } : {}),
    });
  });
}

/**
 * The producers of what a person decides at `gate` (FR-11): the plan at G3 (B09), the run at G5
 * and G6 (C07, C08), the change under review at G7 (E01) and its release at G8 (E03).
 */
async function producersOf(tx: TenantScope, intent: Intent, gate: string): Promise<string[]> {
  if (gate === 'G3') return planSubmitters(tx, intent.id);
  if (gate === 'G5' || gate === 'G6') return runProducers(tx, intent.id);
  // E01: the creator, every run's starter, the plan submitters (QUESTIONS #16, AC2).
  if (gate === 'G7') return g7Producers(tx, intent);
  // E03: the producers of the merged change never decide its release.
  if (gate === 'G8') return g8Producers(tx, intent);
  return [];
}

/** The people who submitted a plan file of the intent (B09, ADR-M40 §2.3). */
async function planSubmitters(tx: TenantScope, intentId: string): Promise<string[]> {
  const plans = await tx.plans.list(intentId);
  return [...new Set(plans.map((p) => p.submitted_by).filter((id): id is string => id !== null))];
}

/** The policy context of G6 from the last reading (`ci_checked`). */
async function g6Context(tx: TenantScope, intentId: string) {
  const facts = await gatherG6Facts(tx, intentId);
  return facts ? contextOf(facts) : { securityFindingsUnknown: true };
}

/** The producers of the intent's last run: the person who allowed it, when any (C07, FR-11). */
async function runProducers(tx: TenantScope, intentId: string): Promise<string[]> {
  const run = (await tx.runs.listForIntent(intentId)).at(-1);
  return run?.triggered_by ? [run.triggered_by] : [];
}

/**
 * C13 (ADR-M64 §2.2): a rejection at G4 while the intent is paused there after an L1 run stored
 * its proposal (the latest run ended `succeeded_proposal_only`). Under the intent lock.
 */
async function rejectsProposal(
  tx: TenantScope,
  intent: Intent,
  gate: string,
  command: GateCommand,
): Promise<boolean> {
  if (gate !== 'G4' || command.decision !== 'reject') return false;
  if (intent.status !== 'paused' || intent.current_gate !== 'G4') return false;
  const latest = (await tx.runs.listForIntent(intent.id)).at(-1);
  return latest?.status === 'succeeded_proposal_only';
}

/** A rejection or request for changes of a gate the platform passed, within its block window. */
async function mayBlockPassedGate(
  registry: Registry,
  tx: TenantScope,
  intent: Intent,
  gate: string,
  command: GateCommand,
  now: Date,
): Promise<boolean> {
  if (command.decision === 'approve' || intent.status !== 'in_gate') return false;
  if (!isPassableGate(gate)) return false;
  const { config } = await registry.policyFor(tx, intent.project_id);
  return (await openBlockWindow(tx, intent, gate, config, now)) !== null;
}
