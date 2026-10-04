// Request schema of the gate waiting-time metrics (task E06, D-08 E06 AC1, ADR-M47). Codes and
// times only. The range is half-open UTC [from, to), as in the cost report (ADR-M45 §2.4):
// `YYYY-MM-DD` or an RFC 3339 time ending in `Z`. The range rules (not empty, at most 366 days) are
// checked by the service, so the error detail names the exact issue.
import { GATE_CHECK_MODES, GATE_CODES, RISK_TIERS } from '@sdlc/contracts';
import { PROJECT_SLUG_PATTERN, parseCostReportTime } from '@sdlc/core';
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

export const gateMetricsQuerySchema = z.strictObject({
  /** A project slug; none: the whole tenant (tenant admins). */
  project: z.string().regex(PROJECT_SLUG_PATTERN).optional(),
  gate: z.enum(GATE_CODES).optional(),
  /** The oversight mode recorded with the decisions; open waits ignore it. */
  mode: z.enum(GATE_CHECK_MODES).optional(),
  risk: z.enum(RISK_TIERS).optional(),
  from: time.optional(),
  to: time.optional(),
});
export type GateMetricsQuery = z.infer<typeof gateMetricsQuerySchema>;
