// Request schemas of the escalation endpoints (D-08 B11 AC5, design/ADR-M28 §2.7). Codes and one
// https link only: escalations are kept 2 years and never hold free text.
import {
  ESCALATION_DECISIONS,
  ESCALATION_STATUSES,
  GATE_REASON_CODES,
  PROTECTED_ACTIONS,
} from '@sdlc/contracts';
import { ESCALATION_CODE_PATTERN, INTENT_CODE_PATTERN } from '@sdlc/core';
import { z } from 'zod';

export const MAX_ESCALATION_PAGE = 100;

export const escalationCodeSchema = z.string().regex(ESCALATION_CODE_PATTERN);

export const listEscalationsSchema = z.strictObject({
  /** An intent code or UUID; default: every intent the caller can read. */
  intent: z.union([z.string().regex(INTENT_CODE_PATTERN), z.uuid()]).optional(),
  status: z.enum(ESCALATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ESCALATION_PAGE).default(50),
});

export const escalationDecisionSchema = z.strictObject({
  decision: z.enum(ESCALATION_DECISIONS),
  reason_code: z.enum(GATE_REASON_CODES).optional(),
  reason_ref: z
    .string()
    .max(512)
    .regex(/^https:\/\/[^\s@]+$/)
    .optional(),
  /** Protected actions the decision allows; default depends on the decision (ADR-M28 §2.4). */
  actions: z.array(z.enum(PROTECTED_ACTIONS)).max(PROTECTED_ACTIONS.length).optional(),
});
