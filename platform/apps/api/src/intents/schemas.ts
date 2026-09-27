// Request schemas (D-08 B03 AC3). Codes come from @sdlc/contracts, so the API accepts exactly the
// canonical values. Free text is allowed only where the database keeps editable client text
// (intent title and description); gate decisions take codes and an https link only (ADR-M20).
import {
  DATA_CLASSES,
  GATE_CODES,
  GATE_REASON_CODES,
  INTENT_STATUSES,
  RISK_TIERS,
} from '@sdlc/contracts';
import { COMMAND_DECISIONS, INTENT_CODE_PATTERN, MAX_INTENT_PAGE } from '@sdlc/core';
import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const scopeCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/);

export const createIntentSchema = z.strictObject({
  project: slug,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
  risk_tier: z.enum(RISK_TIERS),
  data_class: z.enum(DATA_CLASSES),
  budget_usd: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,6})?$/)
    .optional(),
  issue_number: z.number().int().positive().optional(),
});

export const listIntentsSchema = z.strictObject({
  project: slug.optional(),
  status: z.enum(INTENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_INTENT_PAGE).default(50),
  cursor: z.string().max(200).optional(),
});

/** An intent code (`INT-2026-0001`) or its UUID. */
export const intentRefSchema = z.union([z.string().regex(INTENT_CODE_PATTERN), z.uuid()]);

export const gateSchema = z.enum(GATE_CODES);

export const decisionSchema = z.strictObject({
  decision: z.enum(COMMAND_DECISIONS),
  reason_code: z.enum(GATE_REASON_CODES).optional(),
  reason_ref: z
    .string()
    .max(512)
    .regex(/^https:\/\/\S+$/)
    .optional(),
  scope: z
    .strictObject({
      environment: scopeCode.optional(),
      resources: z.array(scopeCode).max(50).optional(),
      actions: z.array(scopeCode).max(50).optional(),
    })
    .optional(),
});
