// One step of the intent workflow (D-08 B07, design/D-03 section 6, design/ADR-M30 §2.4, §2.9).
//
// The Temporal workflow (worker) calls this as an activity in a loop. The database is the source of
// truth: each call reads the intent under its lock and makes at most one move, in one transaction
// with its audit event and its status notice (FR-22). A call repeated after a crash changes
// nothing, because the move is a compare-and-set on the intent's status and gate.
//
// Moves (D-03 section 6):
//   draft → G1 (the submit, after the project AI record check of B12) → G2 → G3 → G4 (C06 continues);
//   a rejection at G1–G3 ends the intent as `rejected`; a request for changes keeps it at the gate;
//   HOTL (session 2, QUESTIONS #88): the platform passes G2 or G3 when the policy conditions hold;
//   a person's block within the block window takes the intent back to the passed gate, or ends it;
//   G5 (C07, g5.ts): the run's changes and caps; a block of a passed G5 takes the intent back to
//   G4 (a new run), a scope failure back to G3, where a new plan and a person's approval are needed;
//   G8 (E03, g8.ts): the release approval, sealing the Evidence Pack, `done`.
// A gate that waits for a person past its deadline raises one escalation (session 2, #90); the
// step asks the workflow to wake it at the deadline (`wakeInMs`).
//
// Rules that are not configuration (design, not tunable values):
// - The gate order (D-03 section 6). No gate ever passes by silence: an approval is a person's
//   decision; the registry refuses a system `pass` at a HITL gate. A HOTL pass needs its
//   conditions (hotl.ts) and never repeats on an input a person sent back.
// - A decision counts only when recorded after the intent last entered the gate and after the last
//   request for changes at that gate. The order comes from the audit chain (`seq`), which is exact
//   where the timestamps of concurrent transactions are not.
// - Before every advance: the freeze check (`gate_advance`, ADR-M28 §2.4) and the approval binding
//   (FR-17: `revalidateApprovals` voids an approval that expired or no longer matches the input).
//   Ending the intent or sending it back is never frozen.
// Tunable values come from the project configuration through the policy engine: the oversight mode,
// the roles and the number of approvals per gate and risk tier, the approval expiry, the HOTL block
// window, the gate deadline and the overdue escalation's severity and level.
import {
  GitHostError,
  type GateCode,
  type IntentStepResult,
  type OversightResolution,
  type PolicyEngine,
  type ProjectRole,
  type ValidatedProjectConfig,
} from '@sdlc/contracts';

import { checkAiRecordAtSubmit } from '../ai-record/g1-check.js';
import {
  gateInputSha256,
  intentInputSha256,
  isCommandGate,
  type CommandGate,
} from '../commands/gate-input.js';
import { CommandError } from '../commands/errors.js';
import type { IntentNoticeKind } from '../db/repositories/intent-notices.js';
import type { Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { EscalationError } from '../escalation/errors.js';
import { assertActionAllowed } from '../escalation/freeze.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import type { Registry } from '../registry/registry.js';
import type { SpecGitHost } from '../specs/link.js';
import { gateHistory, type GateHistory } from './gate-history.js';
import {
  earlierBlock,
  hotlBlockWindowOpenUntil,
  hotlConditionsHold,
  sentBackForInput,
  type EarlierBlock,
} from './hotl.js';
import { gatherG4Facts, projectRepoRef, type G4Deps, type G4Facts } from './g4-proposal.js';
import {
  checkSpec,
  gatherSpecFacts,
  isSpecCheckGate,
  type SpecFacts,
  type SpecHold,
} from './spec-check.js';
import { checkPlan, gatherPlanFacts, heldAtG4, type PlanFacts } from './plan-check.js';
import { stepG4 } from './g4.js';
import { stepG5, stepPausedG5 } from './g5.js';
import { stepG6, stepPausedG6 } from './g6.js';
import { readCi, type CiReading, type G6Deps } from './g6-ci.js';
import { stepG7, stepPausedG7 } from './g7.js';
import { stepG8, stepPausedG8 } from './g8.js';
import { readG7, type G7Deps, type G7Reading } from './g7-facts.js';
import { refusedPlanHashes } from './g5-scope.js';
import { checkGateOverdue, closeGateOverdue, gateClockStart } from './overdue.js';
import { gateOversight } from './oversight.js';
import { FEEDBACK_UNAVAILABLE } from './prepare-run.js';
import { lastPushedHead } from './publish-state.js';
import { moveTo, moveToRunning, stepPaused, stepRunning } from './run-lifecycle.js';
import { waitedSeconds } from './waited.js';

export { waitedSeconds };

/**
 * Statuses in which the intent is finished: the workflow ends. `blocked` too (C06: D-03 section 6,
 * Blocked → end; Critical risk or no autonomy at G4).
 */
export const FINISHED_INTENT_STATUSES = ['done', 'rejected', 'cancelled', 'blocked'] as const;

/** Delay before the step tries the Git host again when it could not read the G4 facts. */
export const GIT_HOST_RETRY_MS = 60_000;

/** The gates the workflow moves on people's decisions (B07); G4 onwards come with C06 and later. */
const NEXT_GATE: Readonly<Partial<Record<GateCode, GateCode>>> = { G1: 'G2', G2: 'G3', G3: 'G4' };

export interface StepDeps {
  /** The registry with the apps' policy factory; its clock is the workflow's clock. */
  readonly registry: Registry;
  /**
   * What G4 reads outside the database (C06, ADR-M33): the Git host and the gateway's models.
   * Without it the step does not evaluate G4 and the intent waits there (`later_gate`).
   */
  readonly g4?: G4Deps;
  /**
   * The Git host for the spec re-check at G2, G3 and G4 (B08, ADR-M39 §2.4): the spec must be the
   * file at the head of the default branch. The worker always wires it; without it (tests of
   * other gates) the step does not re-check the spec.
   */
  readonly specs?: SpecGitHost;
  /**
   * C06 session 2 (ADR-M33 §2.6): the workflow can hand runs to the runner. A decided G4 then
   * moves the intent to `running`, and the step drives the run's round (`run_prepare`,
   * `run_ended`). Without it a decided G4 waits (`run_pending`).
   */
  readonly startRuns?: boolean;
  /**
   * C08 (ADR-M38 §2.1): the workflow can push a run's changes and open its pull request at G6
   * (`publish`). Without it the intent waits at G6 (`later_gate`).
   */
  readonly publish?: boolean;
  /**
   * C08 PR 2 (ADR-M38 §2.7): what G6 reads from CI (the pull request, its checks, its security
   * findings). Without it a linked pull request waits for CI (`ci_pending`).
   */
  readonly g6?: G6Deps;
  /**
   * E01 (ADR-M41): what G7 reads from the Git host (the pull request, its reviews, its commit
   * authors). Without it the intent waits at G7 (`g7_decision`).
   */
  readonly g7?: G7Deps;
  /**
   * E03 (ADR-M49 §2.1): the worker can build Evidence Packs (its evidence store identity). G8 then
   * asks the workflow to build the release pack (`build_pack`); without it the intent waits at G8
   * (`evidence_unavailable`). People's rejections are handled either way.
   */
  readonly releases?: boolean;
}

export class WorkflowError extends Error {
  override readonly name = 'WorkflowError';

  constructor(
    readonly code: 'intent_not_found',
    message: string,
  ) {
    super(message);
  }
}

/** The project configuration and policy engine in force for this step. */
interface StepPolicy {
  readonly config: ValidatedProjectConfig;
  readonly policy: PolicyEngine;
}

const moved: IntentStepResult = { outcome: 'moved' };

function waiting(
  reason: Extract<IntentStepResult, { outcome: 'waiting' }>['reason'],
  wakeInMs?: number,
): IntentStepResult {
  return wakeInMs === undefined
    ? { outcome: 'waiting', reason }
    : { outcome: 'waiting', reason, wakeInMs };
}

/**
 * Makes at most one move of the intent and says what the workflow does next: step again
 * (`moved`), wait for a wake signal or a timer (`waiting`), or end (`finished`).
 */
export async function stepIntent(
  scope: TenantScope,
  deps: StepDeps,
  intentId: string,
): Promise<IntentStepResult> {
  // The spec check (B08) and G4 read the Git host and the gateway first: no HTTP call while the
  // intent lock is held. One head read serves both: the spec checked is the one the run starts
  // from (QUESTIONS #160).
  let facts: G4Facts | undefined;
  let specFacts: SpecFacts | 'git_host_unavailable' | undefined;
  // B09: the plan file at the same head (G3, G4), read in the same way.
  let planFacts: PlanFacts | null | 'git_host_unavailable' = null;
  if (deps.g4 || deps.specs) {
    const peek = await scope.intents.getById(intentId);
    if (peek?.status === 'in_gate' && isSpecCheckGate(peek.current_gate)) {
      try {
        const read = deps.specs ? await gatherSpecFacts(scope, deps.specs, peek) : undefined;
        specFacts = read;
        if (deps.specs && read && peek.current_gate !== 'G2') {
          planFacts = await gatherPlanFacts(scope, deps.specs, peek, read.headSha);
        }
        if (deps.g4 && peek.current_gate === 'G4') {
          facts = await gatherG4Facts(scope, deps.g4, peek, read?.headSha);
        }
      } catch (error) {
        if (!(error instanceof GitHostError)) throw error;
        // G4 needs its facts. At G2 and G3 the gate is held, but people's rejections, requests
        // for changes and the overdue escalation are still handled (`SpecHold`).
        if (deps.g4 && peek.current_gate === 'G4') {
          return {
            outcome: 'waiting',
            reason: 'git_host_unavailable',
            wakeInMs: GIT_HOST_RETRY_MS,
          };
        }
        specFacts = 'git_host_unavailable';
        planFacts = 'git_host_unavailable';
      }
    }
  }
  // C08 PR 2: G6 reads CI before the lock too.
  // An outage does not block people: the step still handles their decisions, then waits.
  let ci: CiReading | 'unavailable' | null = null;
  if (deps.g6 && deps.publish) {
    const peek = await scope.intents.getById(intentId);
    if (peek?.status === 'in_gate' && peek.current_gate === 'G6' && peek.pr_number !== null) {
      try {
        const { config } = await loadEffectiveConfig(scope.projectConfigs, peek.project_id);
        ci = await readCi(scope, deps.g6, peek, config);
      } catch (error) {
        if (!(error instanceof GitHostError)) throw error;
        ci = 'unavailable';
      }
    }
  }
  // E01: G7 reads the pull request and its reviews before the lock too.
  let g7: G7Reading | 'unavailable' | null = null;
  if (deps.g7) {
    const peek = await scope.intents.getById(intentId);
    if (peek?.status === 'in_gate' && peek.current_gate === 'G7' && peek.pr_number !== null) {
      try {
        g7 = await readG7(scope, deps.g7, peek);
      } catch (error) {
        if (!(error instanceof GitHostError)) throw error;
        g7 = 'unavailable';
      }
    }
  }
  // E01 PR 2 (QUESTIONS #191): a run that answered a request for changes failed because the
  // feedback was gone; `resume` goes back to G7 when the pull request still shows the pushed
  // commit. Read before the lock.
  const resumeHead = await readResumeHead(scope, deps, intentId);
  return scope.transaction(async (tx) => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (!intent) throw new WorkflowError('intent_not_found', `intent ${intentId} not found`);
    if ((FINISHED_INTENT_STATUSES as readonly string[]).includes(intent.status)) {
      return { outcome: 'finished', status: intent.status };
    }
    if (intent.status === 'draft') return submit(tx, deps, intent);
    if (deps.startRuns && intent.current_gate === 'G4') {
      if (intent.status === 'running') {
        return stepRunning(
          tx,
          deps.registry,
          await deps.registry.policyFor(tx, intent.project_id),
          intent,
        );
      }
      if (intent.status === 'paused') {
        const paused = await stepPaused(tx, deps.registry, intent);
        if (paused !== 'resume') return paused;
        const back = await resumeAtG7(tx, deps.registry, intent, resumeHead);
        if (back !== null) return back;
        await moveTo(tx, deps.registry, intent, 'in_gate', 'G4', 'run_resumed');
        return moved;
      }
    }
    // C07: a G5 breach paused the intent; a person's decision on its escalation moves it on.
    if (intent.status === 'paused' && intent.current_gate === 'G5') {
      return stepPausedG5(
        tx,
        deps.registry,
        await deps.registry.policyFor(tx, intent.project_id),
        intent,
      );
    }
    // C08: the push or the pull request stopped; a person's decision on its escalation moves it on.
    if (intent.status === 'paused' && intent.current_gate === 'G6') {
      return stepPausedG6(
        tx,
        deps.registry,
        await deps.registry.policyFor(tx, intent.project_id),
        intent,
      );
    }
    // E01: G7 stopped (a closed or changed pull request, an early merge); a person decides.
    if (intent.status === 'paused' && intent.current_gate === 'G7') {
      return stepPausedG7(
        tx,
        deps.registry,
        await deps.registry.policyFor(tx, intent.project_id),
        intent,
      );
    }
    // E03: a stored evidence file failed its check at G8; a person decides on the escalation.
    if (intent.status === 'paused' && intent.current_gate === 'G8') {
      return stepPausedG8(tx, deps.registry, intent);
    }
    if (intent.status !== 'in_gate' || intent.current_gate === null) return waiting('not_in_gate');
    const policy = await deps.registry.policyFor(tx, intent.project_id);
    const block = await earlierBlock(tx, intent, policy.config);
    if (block) return sendBack(tx, deps, policy, intent, block);
    // B08: the spec must still be the file at the head of the default branch (N4).
    let hold: SpecHold | null = null;
    if (specFacts) {
      const spec = await checkSpec(tx, deps.registry, policy.policy, intent, specFacts);
      if (spec?.kind === 'result') return spec.result;
      if (spec?.kind === 'hold') hold = spec.hold;
      // B09: the plan must still be the submitted file at that head; at G4, the plan G3 approved.
      const plan = await checkPlan(tx, deps.registry, policy, intent, planFacts);
      if (plan?.kind === 'result') return plan.result;
      if (plan?.kind === 'hold') hold ??= plan.hold;
    }
    const gate = intent.current_gate;
    // B09 (ADR-M40 §2.4): a plan to submit again holds G4: no run starts.
    if (gate === 'G4' && hold) return heldAtG4(hold);
    if (gate === 'G4' && facts) return atG4(tx, deps, policy, intent, facts);
    if (gate === 'G5') return stepG5(tx, deps.registry, policy, intent);
    // C08: the push and the pull request (`publish`); without them G6 waits.
    if (gate === 'G6' && deps.publish) return stepG6(tx, deps.registry, policy, intent, ci);
    // E01: review and merge.
    if (gate === 'G7' && deps.g7) return stepG7(tx, deps.registry, policy, intent, g7);
    // E03: the release.
    if (gate === 'G8') return stepG8(tx, deps.registry, policy, intent, deps.releases === true);
    if (!isCommandGate(gate)) {
      if (hold) return waiting(hold.reason, hold.wakeInMs);
      // G4 onwards: C06 continues. Wake when the last HOTL block window closes (C06 waits for it).
      const until = await hotlBlockWindowOpenUntil(tx, deps.registry, intent.id);
      return waiting('later_gate', untilMs(deps, until));
    }
    return stepGate(tx, deps, policy, intent, gate, hold);
  });
}

/** G4 (C06): block, wait, or wait for the run (`run_pending`). */
async function atG4(
  tx: TenantScope,
  deps: StepDeps,
  policy: StepPolicy,
  intent: Intent,
  facts: G4Facts,
): Promise<IntentStepResult> {
  const outcome = await stepG4(tx, deps.registry, policy, intent, facts);
  if (outcome.kind === 'waiting') return outcome.result;
  if (outcome.kind === 'decided') {
    if (!deps.startRuns) return waiting('run_pending');
    // In the transaction that checked the block window and the freeze (ADR-M30 §2.4b).
    return (await moveToRunning(tx, deps.registry, intent)) ? moved : waiting('run_pending');
  }
  return outcome.kind === 'rejected'
    ? move(
        tx,
        deps,
        policy,
        intent,
        { status: 'rejected', gate: 'G4' },
        'rejected',
        outcome.decisionId,
      )
    : move(
        tx,
        deps,
        policy,
        intent,
        { status: 'blocked', gate: 'G4' },
        'blocked',
        outcome.decisionId,
      );
}

/** Draft → G1. Creating the intent is the submit (QUESTIONS #89). */
async function submit(tx: TenantScope, deps: StepDeps, intent: Intent): Promise<IntentStepResult> {
  // FR-19 (B12, ADR-M32 §2.5): no G1 without a project AI record that allows the data class.
  if (await checkAiRecordAtSubmit(tx, deps.registry, intent)) return waiting('ai_record');
  if (!(await gateAdvanceAllowed(tx, intent, deps.registry.now()))) return waiting('frozen');
  const policy = await deps.registry.policyFor(tx, intent.project_id);
  return move(tx, deps, policy, intent, { status: 'in_gate', gate: 'G1' }, 'submitted', null);
}

/**
 * A person blocked an earlier gate within its HOTL block window: a request for changes takes the
 * intent back to that gate, a rejection ends it. Never frozen: it stops work, it does not advance.
 */
async function sendBack(
  tx: TenantScope,
  deps: StepDeps,
  policy: StepPolicy,
  intent: Intent,
  block: EarlierBlock,
): Promise<IntentStepResult> {
  const current = intent.current_gate;
  if (current !== null && isCommandGate(current)) {
    await closeGateOverdue(tx, deps.registry, intent.id, current);
  }
  return block.decision === 'reject'
    ? move(
        tx,
        deps,
        policy,
        intent,
        { status: 'rejected', gate: block.gate },
        'rejected',
        block.decisionId,
      )
    : move(
        tx,
        deps,
        policy,
        intent,
        // C07: changes requested on a passed G5 mean a new run on the approved plan, after G4;
        // C08 PR 2: the same for a passed G6.
        {
          status: 'in_gate',
          gate: block.gate === 'G5' || block.gate === 'G6' ? 'G4' : block.gate,
        },
        'returned',
        block.decisionId,
      );
}

async function stepGate(
  tx: TenantScope,
  deps: StepDeps,
  policy: StepPolicy,
  intent: Intent,
  gate: CommandGate,
  /** B08: the spec check holds the gate: no advance, everything else as usual. */
  hold: SpecHold | null = null,
): Promise<IntentStepResult> {
  const { registry } = deps;
  const history = await gateHistory(tx, intent.id, gate);

  // A rejection ends the intent. Ending it is never frozen (ADR-M28 §2.7: cancelling is allowed).
  if (history.rejection !== null) {
    await closeGateOverdue(tx, registry, intent.id, gate);
    return move(
      tx,
      deps,
      policy,
      intent,
      { status: 'rejected', gate },
      'rejected',
      history.rejection,
    );
  }
  if (history.latestChangesRequest && !(await announced(tx, history))) {
    // A person decided the gate: the overdue escalation closes, and the gate clock starts again.
    await closeGateOverdue(tx, registry, intent.id, gate);
    await tx.intentNotices.record({
      intentId: intent.id,
      kind: 'changes_requested',
      status: intent.status,
      gate,
      previousGate: null,
      decisionId: history.latestChangesRequest,
      audienceRoles: await nextActors(tx, policy, intent, gate),
    });
  }

  const oversight = await resolveOversight(tx, policy, intent, gate);
  const clockStart = gateClockStart(intent, history.latestChangesRequestAt);
  const overdue = (subject: { kind: 'intent' | 'spec' | 'plan'; sha256: string }) =>
    checkGateOverdue(tx, registry, {
      intent,
      gate,
      config: policy.config,
      oversight,
      clockStart,
      subject,
    });

  let inputSha256: string;
  try {
    inputSha256 = await gateInputSha256(tx, intent, gate);
  } catch (error) {
    if (error instanceof CommandError && error.code === 'gate_input_missing') {
      // The gate waits for a person to link the spec or submit the plan: the deadline runs.
      return waiting(
        'input_missing',
        await overdue({ kind: 'intent', sha256: intentInputSha256(intent) }),
      );
    }
    throw error;
  }
  // B08: the spec cannot be checked now; the gate does not advance, but its deadline still runs.
  if (hold) {
    const subject = gate === 'G1' ? 'intent' : gate === 'G2' ? 'spec' : 'plan';
    const wake = await overdue({ kind: subject, sha256: inputSha256 });
    return waiting(hold.reason, earliest(wake, hold.wakeInMs));
  }
  // C07 (QUESTIONS #131): a plan that a run went outside of is never approved again.
  if (gate === 'G3' && (await refusedPlanHashes(tx, intent.id)).has(inputSha256)) {
    return waiting('new_plan_needed', await overdue({ kind: 'plan', sha256: inputSha256 }));
  }
  // FR-17: an approval that expired or no longer matches the input is voided before it counts.
  const { valid } = await registry.revalidateApprovals(tx, {
    intentId: intent.id,
    gate,
    inputSha256,
  });
  const approvals = valid.filter((a) => history.countedApprovals.has(a.id));
  if (approvals.length >= approvalsNeeded(oversight)) {
    await closeGateOverdue(tx, registry, intent.id, gate);
    if (!(await gateAdvanceAllowed(tx, intent, registry.now()))) return waiting('frozen');
    const last = approvals.at(-1)!;
    return move(
      tx,
      deps,
      policy,
      intent,
      { status: 'in_gate', gate: NEXT_GATE[gate]! },
      'advanced',
      last.id,
    );
  }

  // HOTL (QUESTIONS #88, option A): the platform passes the gate when its conditions hold.
  if (
    oversight.mode === 'HOTL' &&
    (await hotlConditionsHold(tx, intent, gate)) &&
    !(await sentBackForInput(tx, intent.id, gate, inputSha256))
  ) {
    await closeGateOverdue(tx, registry, intent.id, gate);
    if (!(await gateAdvanceAllowed(tx, intent, registry.now()))) return waiting('frozen');
    const pass = await registry.decide(tx, {
      intentId: intent.id,
      gate,
      decision: 'pass',
      actor: { type: 'system' },
      inputSha256,
      waitedSeconds: waitedSeconds(intent, registry.now()),
      source: 'workflow',
    });
    return move(
      tx,
      deps,
      policy,
      intent,
      { status: 'in_gate', gate: NEXT_GATE[gate]! },
      'hotl_passed',
      pass.id,
    );
  }

  const subjectKind = gate === 'G1' ? 'intent' : gate === 'G2' ? 'spec' : 'plan';
  return waiting('decision', await overdue({ kind: subjectKind, sha256: inputSha256 }));
}

/**
 * Approvals from different people that the gate needs to move on a person's decision: HITL the
 * matrix count (dual approval included), HOTL one explicit approval. At least one: a person
 * decides. AUDIT or POLICY cannot be decided by a person at G1–G3: the gate waits.
 */
function approvalsNeeded(oversight: OversightResolution): number {
  if (oversight.mode === 'HITL') return Math.max(1, oversight.approvalsNeeded);
  if (oversight.mode === 'HOTL') return 1;
  return Number.POSITIVE_INFINITY;
}

async function resolveOversight(
  tx: TenantScope,
  policy: StepPolicy,
  intent: Intent,
  gate: GateCode,
): Promise<OversightResolution> {
  // U01 (QUESTIONS #261): one resolution for the workflow and the API's `waiting_for`; G3 is
  // HITL once G5 sent the intent back for scope (C07, QUESTIONS #131).
  return gateOversight(tx, policy.policy, intent, gate);
}

/** The roles that act next at `gate`: the gate's approvers or the people it notifies. */
async function nextActors(
  tx: TenantScope,
  policy: StepPolicy,
  intent: Intent,
  gate: GateCode,
): Promise<ProjectRole[]> {
  const oversight = await resolveOversight(tx, policy, intent, gate);
  return oversight.roles.filter((role) => role !== 'viewer');
}

async function announced(tx: TenantScope, history: GateHistory): Promise<boolean> {
  return history.latestChangesRequest !== null
    ? tx.intentNotices.existsForDecision(history.latestChangesRequest)
    : true;
}

/** The freeze check before a move (ADR-M28 §2.4). A frozen intent waits; it never fails. */
async function gateAdvanceAllowed(tx: TenantScope, intent: Intent, at: Date): Promise<boolean> {
  try {
    await assertActionAllowed(tx, intent.id, 'gate_advance', at);
    return true;
  } catch (error) {
    if (error instanceof EscalationError && error.code === 'frozen') return false;
    throw error;
  }
}

/** The earlier of two optional delays. */
function earliest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function untilMs(deps: StepDeps, until: Date | null): number | undefined {
  return until === null ? undefined : Math.max(0, until.getTime() - deps.registry.now().getTime());
}

/**
 * The roles a notice mentions. HOTL pass: the people the passed gate tells (they may block it)
 * and the next gate's actors. A return: the actors of the gate the intent went back to.
 */
async function audienceFor(
  tx: TenantScope,
  policy: StepPolicy,
  intent: Intent,
  to: { readonly status: 'in_gate' | 'rejected' | 'blocked'; readonly gate: GateCode },
  kind: IntentNoticeKind,
  passedGate: GateCode | null,
): Promise<ProjectRole[]> {
  if (to.status === 'blocked') return ['person_a'];
  if (to.status !== 'in_gate') return [];
  const roles = isCommandGate(to.gate) ? await nextActors(tx, policy, intent, to.gate) : [];
  if (kind === 'hotl_passed' && passedGate !== null) {
    roles.push(...(await nextActors(tx, policy, intent, passedGate)));
  }
  return [...new Set(roles)];
}

async function move(
  tx: TenantScope,
  deps: StepDeps,
  policy: StepPolicy,
  intent: Intent,
  to: { readonly status: 'in_gate' | 'rejected' | 'blocked'; readonly gate: GateCode },
  kind: IntentNoticeKind,
  decisionId: string | null,
): Promise<IntentStepResult> {
  const updated = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: intent.current_gate },
    to: { status: to.status, currentGate: to.gate },
    at: deps.registry.now(),
  });
  // Under the intent lock the compare-and-set cannot miss; if it does, read the state again.
  if (!updated) return moved;
  await tx.intentNotices.record({
    intentId: intent.id,
    kind,
    status: updated.status,
    gate: updated.current_gate,
    previousGate: intent.current_gate,
    decisionId,
    audienceRoles: await audienceFor(tx, policy, updated, to, kind, intent.current_gate),
  });
  return moved;
}

/** The pull request as the `resume` of a feedback-failed run sees it (QUESTIONS #191). */
type ResumeHead = { readonly open: boolean; readonly headSha: string } | 'unavailable' | null;

/** Null unless the intent is paused at G4 after a run failed for its G7 feedback. */
async function readResumeHead(
  scope: TenantScope,
  deps: StepDeps,
  intentId: string,
): Promise<ResumeHead> {
  if (!deps.g7 || !deps.startRuns) return null;
  const peek = await scope.intents.getById(intentId);
  if (peek?.status !== 'paused' || peek.current_gate !== 'G4' || peek.pr_number === null) {
    return null;
  }
  const latest = (await scope.runs.listForIntent(intentId)).at(-1);
  if (latest?.stop_reason !== FEEDBACK_UNAVAILABLE) return null;
  const project = await scope.projects.getById(peek.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!ref) return null;
  try {
    const pr = await deps.g7.gitHost.getPullRequest(ref, peek.pr_number);
    return { open: pr.state === 'open' && !pr.merged, headSha: pr.headSha };
  } catch (error) {
    if (!(error instanceof GitHostError)) throw error;
    return 'unavailable';
  }
}

/**
 * QUESTIONS #191: after `resume` on the escalation of a run that failed because the feedback of
 * its request for changes was gone, the intent goes back to G7 when the pull request is open and
 * still shows the commit the platform pushed last; G7 then waits for reviews of that commit. A
 * moved head, a closed pull request, or another failure: null (back to G4, as for any failed
 * run). A Git host that cannot be read: wait and read again (the escalation is closed already).
 */
async function resumeAtG7(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  head: ResumeHead,
): Promise<IntentStepResult | null> {
  const latest = (await tx.runs.listForIntent(intent.id)).at(-1);
  if (latest?.stop_reason !== FEEDBACK_UNAVAILABLE || head === null) return null;
  if (head === 'unavailable') {
    return { outcome: 'waiting', reason: 'git_host_unavailable', wakeInMs: 60_000 };
  }
  const pushed = await lastPushedHead(tx, intent.id);
  if (!head.open || pushed === null || head.headSha !== pushed) return null;
  const updated = await tx.intents.moveState(intent.id, {
    from: { status: intent.status, currentGate: intent.current_gate },
    to: { status: 'in_gate', currentGate: 'G7' },
    at: registry.now(),
  });
  if (!updated) throw new Error(`resume: intent ${intent.id} moved under its lock`);
  await tx.intentNotices.record({
    intentId: intent.id,
    kind: 'g7_resumed',
    status: 'in_gate',
    gate: 'G7',
    previousGate: 'G4',
    decisionId: null,
    audienceRoles: ['person_b'],
  });
  return moved;
}
