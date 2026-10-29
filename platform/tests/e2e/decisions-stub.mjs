// The U07 writes of the stub API (design/ADR-M73 §2.4b, §2.6): a gate decision, a kill, an
// escalation acknowledgement and decision, fictional and in memory. The stub keeps the API's
// rules the screens depend on: a decision needs a step-up bound to its exact body and gate
// input; the refusals of N5 (the producer, a wrong role, the same person twice) come with the
// API's code and reason; a changed gate input is a 409. Nothing here is real data.
import { escalationOf } from './fixtures.mjs';

const USER = '00000000-0000-4000-8000-000000000001';
const NOW = () => new Date().toISOString();
/** The gate input hash the fixtures show for every intent (`gate_input_sha256`). */
const INPUT = 'a'.repeat(64);

const GATE = /^\/v1\/intents\/(INT-2026-[0-9]{4})\/gates\/(G[1-8])\/decisions$/;
const KILL = /^\/v1\/runs\/([0-9a-f-]{36})\/kill$/;
const ACK = /^\/v1\/escalations\/(ESC-2026-[0-9]{4})\/ack$/;
const DECIDE = /^\/v1\/escalations\/(ESC-2026-[0-9]{4})\/decisions$/;

/** N5: the intents where the API refuses the demo person, with the refusal reason. */
const REFUSED = { 'INT-2026-0002': 'producer', 'INT-2026-0003': 'role_missing' };
/** An intent whose gate input changed after the page read it. */
const CHANGED = 'INT-2026-0004';

const refusal = (status, code, reason) => ({
  status,
  body: { error: { code, message: code, ...(reason ? { reason } : {}) } },
});

/** Approvals so far: `<intent>/<gate>`, so a second one by the same person is refused. */
const approved = new Set();

export function isDecisionPath(pathname) {
  return [GATE, KILL, ACK, DECIDE].some((p) => p.test(pathname));
}

/**
 * The answer of a U07 write. `holds(action, expectedInputSha256)` checks the body's step-up
 * like the API: the challenge, the passkey, the action, the request and the bound hash.
 */
export async function decisionWrite(url, body, holds) {
  const gate = GATE.exec(url.pathname);
  if (gate) {
    const [, code, g] = gate;
    const expected = body.expected_input_sha256 ?? null;
    if (!(await holds('gate.decide', expected))) return refusal(403, 'step_up_refused');
    if (code === CHANGED || (expected !== null && expected !== INPUT)) {
      return refusal(409, 'gate_input_conflict');
    }
    const key = `${code}/${g}`;
    const reason = REFUSED[code] ?? (approved.has(key) ? 'already_approved' : null);
    if (reason) return refusal(403, 'decision_not_allowed', reason);
    if (body.decision === 'approve') approved.add(key);
    return {
      status: 201,
      body: {
        id: '00000000-0000-4000-8000-000000000501',
        gate: g,
        decision: body.decision,
        oversight_mode: 'HITL',
        approver_role: 'person_b',
        actor_type: 'human',
        decided_by: USER,
        reason_code: body.reason_code ?? null,
        reason_ref: body.reason_ref ?? null,
        input_sha256: INPUT,
        scope: null,
        expires_at: null,
        config_hash: 'c'.repeat(64),
        source: 'web',
        voids_decision_id: null,
        created_at: NOW(),
      },
    };
  }
  const kill = KILL.exec(url.pathname);
  if (kill) {
    return {
      status: 202,
      body: {
        run: kill[1],
        intent: 'INT-2026-0003',
        status: 'stopping',
        already: false,
        escalation: null,
      },
    };
  }
  const ack = ACK.exec(url.pathname);
  if (ack) {
    const e = escalationOf(ack[1]);
    if (!e) return refusal(404, 'escalation_not_found');
    return {
      status: 200,
      body: { ...e, status: 'acknowledged', acknowledged_by: USER, acknowledged_at: NOW() },
    };
  }
  const decide = DECIDE.exec(url.pathname);
  if (decide) {
    const e = escalationOf(decide[1]);
    if (!e) return refusal(404, 'escalation_not_found');
    // The step-up is bound to the escalation's packet, so the decision must carry that hash.
    const expected = body.expected_input_sha256 ?? null;
    if (!(await holds('escalation.decide', expected))) return refusal(403, 'step_up_refused');
    return {
      status: 201,
      body: {
        ...e,
        status: 'resolved',
        decision: { decision: body.decision },
        decided_by: USER,
        decided_at: NOW(),
      },
    };
  }
  return refusal(404, 'not_found');
}
