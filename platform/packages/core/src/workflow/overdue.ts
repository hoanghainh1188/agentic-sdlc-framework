// Overdue human gates (task B07 session 2, D-02 FR-12 and FR-18, QUESTIONS #90, ADR-M30 §2.9).
//
// A gate that waits for a person has a deadline: its clock starts when the intent enters the gate
// and starts again at each request for changes (Harry, B07 session 2 plan, D4). The deadline is
// `oversight.hitl_gate_deadline` on the working calendar. When it passes, the workflow raises ONE
// escalation for that clock start through B11's `raiseEscalation`: trigger `time`, route `intent`
// when Person A holds the gate's role (otherwise `technical`), severity and response level from
// config `oversight.gate_overdue`. From then on the escalation's own clocks (acknowledge, resolve,
// backup, governance) live in the database and the worker's escalation loop advances them
// (ADR-M28): the workflow adds no timer for them. The workflow closes its escalation itself once
// the gate is decided, so its freeze never blocks the move it was raised for.
import { deadlineFrom } from '@sdlc/config';
import type {
  EscalationRoute,
  GateCode,
  OversightResolution,
  ProjectConfig,
} from '@sdlc/contracts';

import type { Escalation, Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { closeEscalation } from '../escalation/decide.js';
import { raiseEscalation } from '../escalation/raise.js';
import type { Registry } from '../registry/registry.js';

/** Gates that wait for a person with a deadline: G1–G3 (B07) and G4 when HITL (C06). */
export type HumanGate = Extract<GateCode, 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6'>;

/** Statuses of an escalation that is not closed. */
const NOT_CLOSED = ['open', 'acknowledged', 'resolved'] as const;

/** When the gate's clock started: entry into the gate, or the last request for changes after it. */
export function gateClockStart(
  intent: Pick<Intent, 'gate_entered_at' | 'updated_at'>,
  latestChangesRequestAt: Date | null,
): Date {
  const entered = new Date(intent.gate_entered_at ?? intent.updated_at);
  return latestChangesRequestAt !== null && latestChangesRequestAt.getTime() > entered.getTime()
    ? latestChangesRequestAt
    : entered;
}

/** The gate's deadline for a clock started at `start` (working calendar). */
export function gateDeadline(start: Date, config: ProjectConfig): Date {
  return (
    deadlineFrom(start, config.oversight.hitl_gate_deadline, config.escalation.calendar) ?? start
  );
}

/** QUESTIONS #90: `intent` when Person A holds the gate's role, otherwise `technical`. */
export function overdueRoute(oversight: Pick<OversightResolution, 'roles'>): EscalationRoute {
  return oversight.roles.includes('person_a') ? 'intent' : 'technical';
}

function isGateOverdue(escalation: Escalation, gate: HumanGate): boolean {
  return escalation.trigger === 'time' && escalation.packet.gate === gate;
}

export interface OverdueInput {
  readonly intent: Intent;
  readonly gate: HumanGate;
  readonly config: ProjectConfig;
  readonly oversight: OversightResolution;
  readonly clockStart: Date;
  /** The version a decision on the escalation is bound to (the gate's input, or the intent). */
  readonly subject: {
    readonly kind: 'intent' | 'spec' | 'plan' | 'run_contract' | 'g5_input' | 'g6_input';
    readonly sha256: string;
  };
  /**
   * Producers of the change under decision: never owner, backup or decider (FR-18). At G1–G4 none
   * (QUESTIONS #64); at G5 (C07) the person who allowed the run.
   */
  readonly producers?: readonly string[];
}

/**
 * Raises the overdue escalation once the deadline passed, once per clock start. Returns the delay
 * until the deadline while it has not passed (the workflow's timer), otherwise undefined.
 */
export async function checkGateOverdue(
  scope: TenantScope,
  registry: Registry,
  input: OverdueInput,
): Promise<number | undefined> {
  const now = registry.now();
  const deadline = gateDeadline(input.clockStart, input.config);
  if (now.getTime() < deadline.getTime()) return deadline.getTime() - now.getTime();
  const raised = (await scope.escalations.listForIntent(input.intent.id)).some(
    (e) =>
      isGateOverdue(e, input.gate) &&
      new Date(e.created_at).getTime() >= input.clockStart.getTime(),
  );
  if (raised) return undefined;
  const { severity, response_level: responseLevel } = input.config.oversight.gate_overdue;
  await raiseEscalation(
    scope,
    {
      intentId: input.intent.id,
      trigger: 'time',
      route: overdueRoute(input.oversight),
      severity,
      responseLevel,
      packet: {
        subject_kind: input.subject.kind,
        subject_sha256: input.subject.sha256,
        gate: input.gate,
      },
      // At G1–G4 no change has been produced yet (QUESTIONS #64).
      producers: [...(input.producers ?? [])],
      raisedBy: { type: 'system' },
    },
    { now: () => now },
  );
  return undefined;
}

/**
 * Closes the overdue escalations of `gate` that are not closed yet: the gate was decided (moved on,
 * rejected, changes requested, or sent back). Escalations of other triggers are never touched.
 */
export async function closeGateOverdue(
  scope: TenantScope,
  registry: Registry,
  intentId: string,
  gate: HumanGate,
): Promise<number> {
  const open = (await scope.escalations.listForIntent(intentId, { statuses: NOT_CLOSED })).filter(
    (e) => isGateOverdue(e, gate),
  );
  for (const escalation of open) {
    await closeEscalation(
      scope,
      { escalationId: escalation.id, closedBy: { type: 'system' } },
      { now: () => registry.now() },
    );
  }
  return open.length;
}
