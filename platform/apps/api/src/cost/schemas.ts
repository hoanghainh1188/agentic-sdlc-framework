// Request schema of the cost report (task E04, D-08 E04 AC1, ADR-M45 §2.4). Codes and times only.
// The range is half-open UTC [from, to): `YYYY-MM-DD` or an RFC 3339 time ending in `Z`. The
// range rules (not empty, at most 366 days) and "project or intent, never both" are checked by the
// service, so the error detail names the exact issue.
import {
  COST_REPORT_GROUPS,
  INTENT_CODE_PATTERN,
  PROJECT_SLUG_PATTERN,
  parseCostReportTime,
} from '@sdlc/core';
import { z } from 'zod';

const time = z
  .string()
  .max(40)
  .transform((value, ctx) => {
    const at = parseCostReportTime(value);
    if (at === undefined) {
      ctx.addIssue({ code: 'custom', message: 'invalid_time' });
      return z.NEVER;
    }
    return at;
  });

export const costReportQuerySchema = z.strictObject({
  /** A project slug, or an intent code; never both. Neither: the whole tenant. */
  project: z.string().regex(PROJECT_SLUG_PATTERN).optional(),
  intent: z.string().regex(INTENT_CODE_PATTERN).optional(),
  from: time.optional(),
  to: time.optional(),
  by: z.enum(COST_REPORT_GROUPS).optional(),
});
export type CostReportQuery = z.infer<typeof costReportQuerySchema>;
