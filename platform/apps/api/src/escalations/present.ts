// Response body of an escalation (snake_case). Fields are picked explicitly, so a new column never
// leaks into the API by accident. Everything here is a code, an ID, a hash, a time or a link.
import type { Escalation, Intent } from '@sdlc/core';
import { isFreezing } from '@sdlc/core';

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

export function presentEscalation(
  e: Escalation,
  intent: Pick<Intent, 'id' | 'code'>,
): Record<string, unknown> {
  return {
    id: e.id,
    code: e.code,
    intent: { id: intent.id, code: intent.code },
    run_id: e.run_id,
    trigger: e.trigger,
    route: e.route,
    severity: e.severity,
    response_level: e.response_level,
    status: e.status,
    freezes_intent: isFreezing(e),
    current_step: e.current_step,
    owner_id: e.owner_id,
    backup_owner_id: e.backup_owner_id,
    packet: e.packet,
    ack_due_at: iso(e.ack_due_at),
    step_due_at: iso(e.step_due_at),
    resolve_due_at: iso(e.resolve_due_at),
    acknowledged_by: e.acknowledged_by,
    acknowledged_at: iso(e.acknowledged_at),
    decision: e.decision,
    decided_by: e.decided_by,
    decided_at: iso(e.decided_at),
    closed_at: iso(e.closed_at),
    created_at: e.created_at.toISOString(),
  };
}
