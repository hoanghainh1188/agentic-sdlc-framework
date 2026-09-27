// The history of one gate of an intent, read from the audit chain (task B07, design/ADR-M30 §2.4).
//
// Gate decisions and intent moves both append an event to the tenant's audit chain under the audit
// lock, so the chain's `seq` orders them exactly as they committed. Timestamps cannot do this: a
// transaction's `now()` is its start time, and a poll batch that started before a move can commit
// a decision after it.
import type { GateCode } from '@sdlc/contracts';

import type { TenantScope } from '../db/tenant-scope.js';

export interface GateHistory {
  /** Audit `seq` of the event that last moved the intent into the gate; 0 when none is recorded. */
  readonly entrySeq: bigint;
  /** A rejection recorded since the intent entered the gate, if any. */
  readonly rejection: string | null;
  /** The last request for changes since the intent entered the gate, if any. */
  readonly latestChangesRequest: string | null;
  /** When it was recorded (its audit event, registry clock). */
  readonly latestChangesRequestAt: Date | null;
  /** Approvals that count: recorded after the entry and after the last request for changes. */
  readonly countedApprovals: ReadonlySet<string>;
  /**
   * The last HOTL `pass` of the platform since the intent entered the gate, if any (session 2,
   * QUESTIONS #88). A person may block the passed gate within its block window.
   */
  readonly pass: string | null;
  /** When the pass was recorded (its audit event, registry clock): the block window starts. */
  readonly passAt: Date | null;
  /**
   * A person's block of the passed gate, recorded after the `pass`: a rejection if any, otherwise
   * the last request for changes. Null when there is no pass or no block.
   */
  readonly blockAfterPass: {
    readonly decisionId: string;
    readonly decision: 'reject' | 'request_changes';
  } | null;
}

interface DecidedEvent {
  readonly seq: bigint;
  readonly decisionId: string;
  readonly decision: string;
  readonly at: Date;
}

function field(payload: unknown, key: string): unknown {
  return payload !== null && typeof payload === 'object'
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

export async function gateHistory(
  scope: TenantScope,
  intentId: string,
  gate: GateCode,
): Promise<GateHistory> {
  const events = await scope.audit.listForEntity(intentId, [
    'intent.state_changed',
    'gate.decided',
  ]);
  let entrySeq = 0n;
  for (const event of events) {
    if (
      event.action === 'intent.state_changed' &&
      field(event.payload, 'status') === 'in_gate' &&
      field(event.payload, 'current_gate') === gate
    ) {
      entrySeq = BigInt(event.seq);
    }
  }
  const decided: DecidedEvent[] = events
    .filter(
      (event) =>
        event.action === 'gate.decided' &&
        BigInt(event.seq) > entrySeq &&
        field(event.payload, 'gate') === gate,
    )
    .map((event) => ({
      seq: BigInt(event.seq),
      decisionId: String(field(event.payload, 'decision_id')),
      decision: String(field(event.payload, 'decision')),
      at: new Date(event.occurred_at),
    }));

  const rejection = decided.find((d) => d.decision === 'reject');
  const changes = decided.filter((d) => d.decision === 'request_changes').at(-1);
  const after = changes?.seq ?? entrySeq;
  const pass = decided.filter((d) => d.decision === 'pass').at(-1);
  const blocks = pass ? decided.filter((d) => d.seq > pass.seq) : [];
  const block =
    blocks.find((d) => d.decision === 'reject') ??
    blocks.filter((d) => d.decision === 'request_changes').at(-1);
  return {
    entrySeq,
    rejection: rejection?.decisionId ?? null,
    latestChangesRequest: changes?.decisionId ?? null,
    latestChangesRequestAt: changes?.at ?? null,
    countedApprovals: new Set(
      decided.filter((d) => d.decision === 'approve' && d.seq > after).map((d) => d.decisionId),
    ),
    pass: pass?.decisionId ?? null,
    passAt: pass?.at ?? null,
    blockAfterPass: block
      ? {
          decisionId: block.decisionId,
          decision: block.decision as 'reject' | 'request_changes',
        }
      : null,
  };
}

/** When a gate decision was recorded: the `occurred_at` of its audit event (registry clock). */
export async function decisionRecordedAt(
  scope: TenantScope,
  intentId: string,
  decisionId: string,
): Promise<Date | null> {
  const events = await scope.audit.listForEntity(intentId, ['gate.decided']);
  const event = events.find((e) => field(e.payload, 'decision_id') === decisionId);
  return event ? new Date(event.occurred_at) : null;
}
