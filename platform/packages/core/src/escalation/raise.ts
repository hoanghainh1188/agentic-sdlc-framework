// Raising an escalation (D-08 B11 AC1 and AC2, D-02 FR-18, handbook Ch.6 §6.4, design/ADR-M28).
// Callers: B07 (overdue gate, `time`), C07 (G5 breach), C11 (kill switch, stopped run), G6
// (critical finding), and people through the API later. One transaction: the row, its audit
// events and its first notices commit together.
import {
  FREEZING_RESPONSE_LEVELS,
  type EscalationRoute,
  type EscalationTrigger,
  type ResponseLevel,
  type Severity,
} from '@sdlc/contracts';

import { DbError } from '../db/errors.js';
import type { Escalation } from '../db/schema.js';
import { isUuid } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { initialClocks, nextCheckAt } from './clock.js';
import { EscalationError } from './errors.js';
import { raisedNotices } from './notices.js';
import { checkPacket } from './packet.js';
import { firstStep, isUnrouted, resolveHolders } from './routing.js';

/** Intents in these statuses are finished: nothing to escalate. */
const CLOSED_INTENT_STATUSES: readonly string[] = ['done', 'rejected', 'cancelled', 'blocked'];

/** People raise escalations as themselves; the workflow, runner and clock as the system. */
export type EscalationRaiser =
  { readonly type: 'system' } | { readonly type: 'human'; readonly id: string };

export interface RaiseEscalationInput {
  readonly intentId: string;
  readonly runId?: string | null;
  readonly trigger: EscalationTrigger;
  /** Who receives it first (QUESTIONS #74). */
  readonly route: EscalationRoute;
  readonly severity: Severity;
  readonly responseLevel: ResponseLevel;
  /** The decision packet: codes, IDs, one hash, one link (`EscalationPacket`). */
  readonly packet: Readonly<Record<string, unknown>>;
  /** Producers of the change: never owner, backup or decider (FR-18). Platform user IDs. */
  readonly producers: readonly string[];
  readonly raisedBy: EscalationRaiser;
}

export interface EscalationDeps {
  /** Escalation clock. Default: `new Date()`. */
  readonly now?: () => Date;
}

/**
 * Raises an escalation on an open intent: checks the packet, routes it from the project
 * configuration and role bindings, starts both clocks, and records `escalation.created` and the
 * first notices. A G5 breach must use at least `pause` (QUESTIONS #21): the run stops, and only a
 * person's decision resumes it.
 */
// async: a refused input rejects the promise instead of throwing synchronously.
export async function raiseEscalation(
  scope: TenantScope,
  input: RaiseEscalationInput,
  deps: EscalationDeps = {},
): Promise<Escalation> {
  const packet = checkPacket(input.packet);
  if (packet.gate === 'G5' && !isFreezingLevel(input.responseLevel)) {
    throw new EscalationError(
      'response_level_too_low',
      `a G5 escalation needs at least pause, got ${input.responseLevel}`,
    );
  }
  if (input.producers.some((id) => !isUuid(id))) {
    throw new DbError('invalid_value', 'producers must be user IDs');
  }
  const now = deps.now ? deps.now() : new Date();

  return await scope.transaction(async (tx) => {
    const intent = await tx.intents.getById(input.intentId);
    if (!intent) throw new EscalationError('not_found', `intent ${input.intentId} not found`);
    if (CLOSED_INTENT_STATUSES.includes(intent.status)) {
      throw new EscalationError('intent_not_open', `intent ${intent.code} is ${intent.status}`);
    }
    const { config } = await loadEffectiveConfig(tx.projectConfigs, intent.project_id);
    const settings = config.escalation;
    const holders = await resolveHolders(
      tx,
      intent.project_id,
      settings.routing[input.route],
      input.producers,
    );
    const step = firstStep(holders);
    const clocks = initialClocks(now, input.severity, settings);
    const next = nextCheckAt({
      severity: input.severity,
      status: 'open',
      currentStep: step,
      backupOwnerId: holders.backupOwnerId,
      stepDueAt: clocks.dueAt,
      remindAt: clocks.remindAt,
      remindedStep: null,
      ackMissedAt: null,
      governanceOverdueAt: null,
      resolveDueAt: clocks.resolveDueAt,
      resolveOverdueAt: null,
    });

    const escalation = await tx.escalations.create({
      intentId: intent.id,
      runId: input.runId ?? null,
      trigger: input.trigger,
      route: input.route,
      severity: input.severity,
      responseLevel: input.responseLevel,
      packet,
      producerIds: [...new Set(input.producers)],
      ownerId: holders.ownerId,
      backupOwnerId: holders.backupOwnerId,
      currentStep: step,
      ackDueAt: clocks.dueAt,
      remindAt: clocks.remindAt,
      resolveDueAt: clocks.resolveDueAt,
      nextCheckAt: next,
      createdAt: now,
    });

    const actor =
      input.raisedBy.type === 'human'
        ? { actorType: 'human' as const, actorId: input.raisedBy.id }
        : { actorType: 'system' as const, actorId: null };
    await tx.audit.append({
      action: 'escalation.created',
      ...actor,
      entityId: escalation.id,
      payload: {
        code: escalation.code,
        intent_id: intent.id,
        trigger: input.trigger,
        route: input.route,
        severity: input.severity,
        response_level: input.responseLevel,
        step,
        subject_sha256: packet.subject_sha256,
        ...(escalation.run_id ? { run_id: escalation.run_id } : {}),
        ...(packet.gate ? { gate: packet.gate } : {}),
      },
    });
    if (isUnrouted(holders)) {
      await tx.audit.append({
        action: 'escalation.unrouted',
        actorType: 'system',
        actorId: null,
        entityId: escalation.id,
        payload: { code: escalation.code },
      });
    }
    await tx.escalationNotices.record(
      escalation.id,
      raisedNotices(input.route, input.severity, step, settings),
    );
    return escalation;
  });
}

function isFreezingLevel(level: ResponseLevel): boolean {
  return (FREEZING_RESPONSE_LEVELS as readonly ResponseLevel[]).includes(level);
}
