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
  /** Approvals that count: recorded after the entry and after the last request for changes. */
  readonly countedApprovals: ReadonlySet<string>;
}

interface DecidedEvent {
  readonly seq: bigint;
  readonly decisionId: string;
  readonly decision: string;
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
    }));

  const rejection = decided.find((d) => d.decision === 'reject');
  const changes = decided.filter((d) => d.decision === 'request_changes').at(-1);
  const after = changes?.seq ?? entrySeq;
  return {
    entrySeq,
    rejection: rejection?.decisionId ?? null,
    latestChangesRequest: changes?.decisionId ?? null,
    countedApprovals: new Set(
      decided.filter((d) => d.decision === 'approve' && d.seq > after).map((d) => d.decisionId),
    ),
  };
}
