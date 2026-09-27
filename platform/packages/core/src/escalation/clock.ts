// The escalation clocks (handbook Ch.6 §6.4 SLA, §6.5 "When nobody responds"; D-02 FR-18;
// QUESTIONS #73, #75; design/ADR-M28 §2.2).
//
// Pure functions: the state lives in the `escalations` row, the worker loop calls `advanceClock`
// with the current time, and the result is written back. Running it twice at the same time gives
// the same result, so a restart or a second worker never repeats a step.
//
// - Two clocks always run: acknowledge (per step) and resolve (from creation). Sending a message is
//   not an acknowledgement: only `/ack` or the API stops the acknowledge clock (PR 2).
// - Each step (owner, backup, governance) gets a fresh acknowledge window from the SLA table. The
//   window of the next step starts when the previous one ran out, not when the loop noticed.
// - A reminder goes to the step's holder when `reminder_percent` of the window has passed.
// - When governance misses its window too, that is recorded once; the escalation stays frozen.
// - When the resolve deadline passes, governance takes over; for Critical, the incident process is
//   due (the incident module is MVP+1, so this is an audit event and a notice).
// - Working-time units follow the project's working calendar (holidays included).
import { addWorkingMinutes, deadlineFrom, durationMinutes } from '@sdlc/config';
import type {
  Duration,
  EscalationStatus,
  EscalationStep,
  Severity,
  ValidatedProjectConfig,
} from '@sdlc/contracts';

type EscalationSettings = ValidatedProjectConfig['escalation'];

const MINUTE_MS = 60_000;
/** Enough for owner → backup → governance, reminders and the resolve deadline, with margin. */
const MAX_EVENTS_PER_ADVANCE = 16;

export interface ClockState {
  readonly severity: Severity;
  readonly status: EscalationStatus;
  readonly currentStep: EscalationStep;
  /** Null: the backup role had no holder, so a missed owner step goes to governance. */
  readonly backupOwnerId: string | null;
  readonly stepDueAt: Date;
  readonly remindAt: Date | null;
  readonly remindedStep: EscalationStep | null;
  readonly ackMissedAt: Date | null;
  readonly governanceOverdueAt: Date | null;
  readonly resolveDueAt: Date | null;
  readonly resolveOverdueAt: Date | null;
}

/** What one clock event changed. Each becomes an audit event and notices. */
export type ClockEffect =
  | { readonly kind: 'reminded'; readonly at: Date; readonly step: EscalationStep }
  | {
      readonly kind: 'step_changed';
      readonly at: Date;
      readonly from: EscalationStep;
      readonly to: EscalationStep;
    }
  | { readonly kind: 'governance_overdue'; readonly at: Date }
  | {
      readonly kind: 'resolve_overdue';
      readonly at: Date;
      readonly from: EscalationStep;
      /** Critical: the incident process is due (Ch.6 §6.5 "Critical timeout"). */
      readonly incident: boolean;
    };

export interface StepWindow {
  readonly dueAt: Date;
  readonly remindAt: Date | null;
}

/** The acknowledge window of a step that starts at `start`. */
export function stepWindow(
  start: Date,
  severity: Severity,
  settings: EscalationSettings,
): StepWindow {
  const acknowledge = settings.sla[severity].acknowledge;
  const dueAt = deadlineFrom(start, acknowledge, settings.calendar)!;
  return { dueAt, remindAt: remindTime(start, acknowledge, settings) };
}

function remindTime(start: Date, window: Duration, settings: EscalationSettings): Date | null {
  const minutes = Math.floor(
    (durationMinutes(window, settings.calendar) * settings.reminder_percent) / 100,
  );
  if (minutes < 1) return null;
  return window.unit === 'working_hours' || window.unit === 'working_days'
    ? addWorkingMinutes(start, minutes, settings.calendar)
    : new Date(start.getTime() + minutes * MINUTE_MS);
}

export interface InitialClocks extends StepWindow {
  /** Null for "next planned work" (no resolve clock). */
  readonly resolveDueAt: Date | null;
}

/** The clocks of a new escalation raised at `createdAt`. */
export function initialClocks(
  createdAt: Date,
  severity: Severity,
  settings: EscalationSettings,
): InitialClocks {
  const window = stepWindow(createdAt, severity, settings);
  const resolveDueAt = deadlineFrom(createdAt, settings.sla[severity].resolve, settings.calendar);
  return { ...window, resolveDueAt };
}

type Pending = 'remind' | 'step' | 'resolve';
const PRIORITY: readonly Pending[] = ['remind', 'step', 'resolve'];

function pending(state: ClockState): { kind: Pending; at: Date }[] {
  const found: { kind: Pending; at: Date }[] = [];
  const open = state.status === 'open';
  if (open && state.remindAt !== null && state.remindedStep !== state.currentStep) {
    found.push({ kind: 'remind', at: state.remindAt });
  }
  if (open && (state.currentStep !== 'governance' || state.governanceOverdueAt === null)) {
    found.push({ kind: 'step', at: state.stepDueAt });
  }
  const unresolved = state.status === 'open' || state.status === 'acknowledged';
  if (unresolved && state.resolveDueAt !== null && state.resolveOverdueAt === null) {
    found.push({ kind: 'resolve', at: state.resolveDueAt });
  }
  return found;
}

/** The earliest pending clock, or null when nothing is pending (the `next_check_at` column). */
export function nextCheckAt(state: ClockState): Date | null {
  const times = pending(state).map((p) => p.at.getTime());
  return times.length === 0 ? null : new Date(Math.min(...times));
}

function nextStep(state: ClockState): EscalationStep {
  return state.currentStep === 'owner' && state.backupOwnerId !== null ? 'backup' : 'governance';
}

function apply(
  state: ClockState,
  kind: Pending,
  at: Date,
  settings: EscalationSettings,
): { state: ClockState; effect: ClockEffect } {
  if (kind === 'remind') {
    return {
      state: { ...state, remindedStep: state.currentStep },
      effect: { kind: 'reminded', at, step: state.currentStep },
    };
  }
  const ackMissedAt = state.ackMissedAt ?? at;
  if (kind === 'step' && state.currentStep === 'governance') {
    return {
      state: { ...state, governanceOverdueAt: at, ackMissedAt },
      effect: { kind: 'governance_overdue', at },
    };
  }
  if (kind === 'step') {
    const to = nextStep(state);
    const window = stepWindow(at, state.severity, settings);
    return {
      state: {
        ...state,
        currentStep: to,
        stepDueAt: window.dueAt,
        remindAt: window.remindAt,
        ackMissedAt,
      },
      effect: { kind: 'step_changed', at, from: state.currentStep, to },
    };
  }
  // The resolve deadline passed: governance takes over (#75). An open escalation gets a fresh
  // acknowledge window for governance; an acknowledged one keeps its (stopped) clock.
  const moved = state.currentStep !== 'governance';
  const window =
    moved && state.status === 'open' ? stepWindow(at, state.severity, settings) : undefined;
  return {
    state: {
      ...state,
      resolveOverdueAt: at,
      currentStep: 'governance',
      ...(window ? { stepDueAt: window.dueAt, remindAt: window.remindAt } : {}),
    },
    effect: {
      kind: 'resolve_overdue',
      at,
      from: state.currentStep,
      incident: state.severity === 'critical',
    },
  };
}

/**
 * Applies every clock event due at `now`, earliest first (ties: reminder, step, resolve), and
 * returns the new state and what happened. Returns the same state and no effects when nothing is due.
 */
export function advanceClock(
  state: ClockState,
  now: Date,
  settings: EscalationSettings,
): { state: ClockState; effects: ClockEffect[] } {
  let current = state;
  const effects: ClockEffect[] = [];
  for (let i = 0; i < MAX_EVENTS_PER_ADVANCE; i += 1) {
    const due = pending(current)
      .filter((p) => p.at.getTime() <= now.getTime())
      .sort(
        (a, b) =>
          a.at.getTime() - b.at.getTime() || PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind),
      )[0];
    if (!due) break;
    const next = apply(current, due.kind, due.at, settings);
    current = next.state;
    effects.push(next.effect);
  }
  return { state: current, effects };
}
