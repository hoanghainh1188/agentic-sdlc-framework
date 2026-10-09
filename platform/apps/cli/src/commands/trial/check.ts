// Step 3 of `sdlc trial report` (task V01, ADR-M65 §2.4): the last check before anything is
// printed, independent of `build.ts`. Every object is strict (an unknown field fails) and every
// string is either a value of a closed list (the same lists `build.ts` uses, plus `other`) or one
// of a few fixed shapes: `project-N`, `intent-N`, a date, a version, a token sum or a USD amount.
// A report that fails is never printed (fail closed).
import {
  ACTOR_TYPES,
  ESCALATION_ROUTES,
  ESCALATION_STATUSES,
  ESCALATION_TRIGGERS,
  GATE_CODES,
  GATE_DECISIONS,
  INTENT_STATUSES,
  RISK_TIERS,
  RUN_STATUSES,
  SEVERITIES,
} from '@sdlc/contracts';
import { z } from 'zod';

import { KNOWN_MODELS, KNOWN_STOP_REASONS, OTHER } from './build.js';

/** One value of `list`, or `other`. */
const oneOf = (list: readonly string[]) => z.enum([OTHER, ...list]);
const n = z.number().int().min(0);
/** Counts keyed by the values of `list` (or `other`). */
const countsOf = (list: readonly string[]) => z.partialRecord(oneOf(list), n);

const gate = oneOf(GATE_CODES);
const projectId = z.string().regex(/^project-[0-9]{1,4}$/);
const intentId = z.string().regex(/^(intent-[0-9]{1,4}|other)$/);
const day = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
/** `x.y.z`, with an optional pre-release (`0.1.0-rc.1`). */
const version = z.string().regex(/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9a-z.]{1,20})?$/);
const tokens = z.string().regex(/^[0-9]{1,20}$/);
const usd = z.string().regex(/^[0-9]{1,15}\.[0-9]{6}$/);

const amounts = z.strictObject({
  calls: n,
  input_tokens: tokens,
  output_tokens: tokens,
  cached_input_tokens: tokens,
  cost_usd: usd,
  wasted_tokens: tokens,
  wasted_cost_usd: usd,
});

const waits = z.strictObject({
  count: n,
  avg_seconds: n.nullable(),
  max_seconds: n.nullable(),
  p50_seconds: n.nullable(),
  p90_seconds: n.nullable(),
});

export const trialReportSchema = z.strictObject({
  schema: z.literal('sdlc-trial-report/1'),
  platform_version: version,
  generated_on: day,
  range: z.strictObject({ from: day, to: day }),
  truncated: z.strictObject({
    intents: z.boolean(),
    escalations: z.boolean(),
    gates: z.boolean(),
    cost: z.boolean(),
  }),
  totals: amounts,
  models: z.array(amounts.extend({ model: oneOf(KNOWN_MODELS) })).max(500),
  projects: z
    .array(
      z.strictObject({
        id: projectId,
        intents_by_status: countsOf(INTENT_STATUSES),
        gates: z
          .array(
            z.strictObject({
              gate,
              first_round: waits,
              after_changes: waits,
              auto_passed: n,
              open: z.strictObject({ count: n, oldest_seconds: n.nullable() }),
            }),
          )
          .max(500),
        escalations: z.strictObject({
          total: n,
          by_trigger: countsOf(ESCALATION_TRIGGERS),
          by_route: countsOf(ESCALATION_ROUTES),
          by_severity: countsOf(SEVERITIES),
          by_status: countsOf(ESCALATION_STATUSES),
        }),
        intents: z
          .array(
            z.strictObject({
              id: intentId,
              risk: oneOf(RISK_TIERS),
              status: oneOf(INTENT_STATUSES),
              gate: gate.nullable(),
              lead_time_seconds: n.nullable(),
              runs: z.strictObject({
                total: n,
                by_status: countsOf(RUN_STATUSES),
                by_stop_reason: countsOf(KNOWN_STOP_REASONS),
              }),
              decisions: z
                .array(
                  z.strictObject({
                    gate,
                    decision: oneOf(GATE_DECISIONS),
                    actor: oneOf(ACTOR_TYPES),
                    count: n,
                  }),
                )
                .max(200),
              g7_requests_for_changes: n,
              escalations: n,
              cost: amounts.nullable(),
            }),
          )
          .max(1000),
      }),
    )
    .max(1000),
});

/** True when the report may be printed. */
export function reportIsSafe(report: unknown): boolean {
  return trialReportSchema.safeParse(report).success;
}
