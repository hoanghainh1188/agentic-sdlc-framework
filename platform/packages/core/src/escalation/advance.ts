// Advances the clock of one escalation (D-08 B11 AC3, handbook Ch.6 §6.5, design/ADR-M28 §2.2).
// Called by the worker loop for each escalation `SystemScope.listDueEscalations` returns. The row is
// locked with `SKIP LOCKED`, so two workers never advance the same escalation at once; the clock
// functions are idempotent, so a restart never repeats a step.
import type { AuditAction, AuditPayload } from '../audit/actions.js';
import type { Escalation } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { advanceClock, nextCheckAt, type ClockEffect, type ClockState } from './clock.js';
import { clockNotices } from './notices.js';
import { currentBackup } from './routing.js';

export type AdvanceOutcome =
  /** At least one clock event was applied. */
  | 'advanced'
  /** Nothing was due (another worker was faster, or the clock moved). */
  | 'unchanged'
  /** Another transaction holds the row, or it does not exist: skipped. */
  | 'skipped';

export interface AdvanceResult {
  readonly outcome: AdvanceOutcome;
  readonly effects: readonly ClockEffect[];
}

export function clockStateOf(row: Escalation): ClockState {
  return {
    severity: row.severity,
    status: row.status,
    currentStep: row.current_step,
    backupOwnerId: row.backup_owner_id,
    stepDueAt: row.step_due_at,
    remindAt: row.remind_at,
    remindedStep: row.reminded_step,
    ackMissedAt: row.ack_missed_at,
    governanceOverdueAt: row.governance_overdue_at,
    resolveDueAt: row.resolve_due_at,
    resolveOverdueAt: row.resolve_overdue_at,
  };
}

/** Applies every clock event of the escalation due at `now`, in one transaction. */
export function advanceEscalation(
  scope: TenantScope,
  escalationId: string,
  now: Date,
): Promise<AdvanceResult> {
  return scope.transaction(async (tx) => {
    const row = await tx.escalations.lockForClock(escalationId);
    if (!row) return { outcome: 'skipped', effects: [] };
    const intent = await tx.intents.getById(row.intent_id);
    if (!intent) return { outcome: 'skipped', effects: [] };
    const { config } = await loadEffectiveConfig(tx.projectConfigs, intent.project_id);
    const settings = config.escalation;
    const routing = settings.routing[row.route];

    let state = clockStateOf(row);
    // Roles can change hands while the owner step waits: the backup is chosen again just before
    // the owner step runs out. Never a producer, never the owner.
    if (state.status === 'open' && state.currentStep === 'owner' && state.stepDueAt <= now) {
      const excluded = [...row.producer_ids, ...(row.owner_id ? [row.owner_id] : [])];
      state = {
        ...state,
        backupOwnerId: await currentBackup(tx, intent.project_id, routing, excluded),
      };
    }
    const { state: next, effects } = advanceClock(state, now, settings);
    const nextCheck = nextCheckAt(next);
    const changed =
      effects.length > 0 ||
      next.backupOwnerId !== row.backup_owner_id ||
      nextCheck?.getTime() !== row.next_check_at?.getTime();
    if (!changed) return { outcome: 'unchanged', effects: [] };

    await tx.escalations.updateClock(
      row.id,
      {
        currentStep: next.currentStep,
        backupOwnerId: next.backupOwnerId,
        stepDueAt: next.stepDueAt,
        remindAt: next.remindAt,
        remindedStep: next.remindedStep,
        ackMissedAt: next.ackMissedAt,
        governanceOverdueAt: next.governanceOverdueAt,
        resolveOverdueAt: next.resolveOverdueAt,
        nextCheckAt: nextCheck,
      },
      now,
    );
    for (const effect of effects) {
      await recordEffect(tx, row, effect);
      await tx.escalationNotices.record(row.id, clockNotices(effect, row.route, settings));
    }
    return { outcome: effects.length > 0 ? 'advanced' : 'unchanged', effects };
  });
}

async function recordEffect(tx: TenantScope, row: Escalation, effect: ClockEffect): Promise<void> {
  const base = { actorType: 'system' as const, actorId: null, entityId: row.id };
  const append = <A extends AuditAction>(action: A, payload: AuditPayload<A>) =>
    tx.audit.append({ ...base, action, payload });
  switch (effect.kind) {
    case 'reminded':
      await append('escalation.reminded', { code: row.code, step: effect.step });
      return;
    case 'step_changed':
      await append('escalation.step_changed', {
        code: row.code,
        from_step: effect.from,
        to_step: effect.to,
      });
      return;
    case 'governance_overdue':
      await append('escalation.ack_overdue', { code: row.code });
      return;
    case 'resolve_overdue':
      await append('escalation.resolve_overdue', { code: row.code, from_step: effect.from });
      if (effect.incident) await append('escalation.incident_due', { code: row.code });
      return;
  }
}
