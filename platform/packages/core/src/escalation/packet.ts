// The decision packet of an escalation (handbook Ch.6 §6.4 "Escalation package", template T16 §2;
// design/ADR-M28 §2.3).
//
// Escalations are kept at least 2 years (D-05 section 10), so the packet holds codes, IDs, one hash
// and one link only. The words of the T16 package (goal, diff, command, impact) stay where they can
// be edited or deleted: the intent's issue, the pull request, the evidence files. `subject_sha256`
// is the version the decision will be bound to (FR-17, Ch.6 §6.6).
import {
  ESCALATION_RECOMMENDATIONS,
  ESCALATION_SUBJECT_KINDS,
  GATE_CODES,
  GATE_REASON_CODES,
  type EscalationRecommendation,
  type EscalationSubjectKind,
  type GateCode,
  type GateReasonCode,
} from '@sdlc/contracts';

import { isUuid } from '../db/tenant-id.js';
import { EscalationError } from './errors.js';

export interface EscalationPacket {
  /** What `subject_sha256` is the hash of. */
  readonly subject_kind: EscalationSubjectKind;
  /** The reviewed version: the decision is bound to it. */
  readonly subject_sha256: string;
  /** The gate that raised it, when a gate did. */
  readonly gate?: GateCode;
  readonly run_id?: string;
  readonly agent_id?: string;
  /** Why, as a gate reason code (for example `budget_exceeded`, `out_of_scope`). */
  readonly reason_code?: GateReasonCode;
  readonly recommendation?: EscalationRecommendation;
  /** One `https://` link to the words: the Git host comment, CI run or evidence page. */
  readonly ref?: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
/** Same rule as the database CHECK (migration 0007): https, no spaces, no '@', ≤ 512 chars. */
const REF = /^https:\/\/[^\s@]{1,504}$/;

type FieldCheck = (value: unknown) => boolean;

const oneOf =
  (list: readonly string[]): FieldCheck =>
  (value) =>
    typeof value === 'string' && list.includes(value);

const FIELDS: Readonly<Record<keyof EscalationPacket, { check: FieldCheck; required: boolean }>> = {
  subject_kind: { check: oneOf(ESCALATION_SUBJECT_KINDS), required: true },
  subject_sha256: {
    check: (value) => typeof value === 'string' && SHA256.test(value),
    required: true,
  },
  gate: { check: oneOf(GATE_CODES), required: false },
  run_id: { check: isUuid, required: false },
  agent_id: { check: isUuid, required: false },
  reason_code: { check: oneOf(GATE_REASON_CODES), required: false },
  recommendation: { check: oneOf(ESCALATION_RECOMMENDATIONS), required: false },
  ref: { check: (value) => typeof value === 'string' && REF.test(value), required: false },
};

/**
 * Checks a packet and returns a copy with exactly the declared fields. Throws
 * `EscalationError('invalid_packet')` for a missing, extra or badly formatted field. An optional
 * field may be left out, never set to null.
 */
export function checkPacket(input: Readonly<Record<string, unknown>>): EscalationPacket {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('the packet must be an object');
  }
  const extra = Object.keys(input).filter((key) => !Object.hasOwn(FIELDS, key));
  if (extra.length > 0) throw invalid(`undeclared packet fields ${extra.join(', ')}`);
  const packet: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(FIELDS)) {
    const value = input[field];
    if (value === undefined && !spec.required) continue;
    if (!spec.check(value)) throw invalid(`packet field ${field} is missing or not valid`);
    packet[field] = value;
  }
  return Object.freeze(packet) as unknown as EscalationPacket;
}

function invalid(message: string): EscalationError {
  return new EscalationError('invalid_packet', message);
}
