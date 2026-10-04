// Cost report (task E04, D-02 FR-53, D-08 E04, ADR-M45). The whole tenant: tenant admins only;
// one project or intent: a tenant admin or a role in `access.cost_read_roles` (no role on the
// project → 404, another role → 403, QUESTIONS #196). The report reads `cost_records` as synced.
import { buildCostReport, checkCostReportRange, resolveCostReportRange } from '@sdlc/core';

import type { Principal } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import { presentCostReport } from './present.js';
import type { CostReportQuery } from './schemas.js';

export class CostService {
  constructor(private readonly now: () => Date) {}

  async report(p: Principal, query: CostReportQuery): Promise<Record<string, unknown>> {
    if (query.project !== undefined && query.intent !== undefined) {
      throw invalid('query.intent', 'project_and_intent');
    }
    const now = this.now();
    const bounds = {
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    };
    const issue = checkCostReportRange(resolveCostReportRange(bounds, now));
    if (issue !== undefined) throw invalid('query.to', issue);
    const report = await buildCostReport(
      p.scope,
      { userId: p.userId },
      {
        ...bounds,
        ...(query.project === undefined ? {} : { projectSlug: query.project }),
        ...(query.intent === undefined ? {} : { intentCode: query.intent }),
        ...(query.by === undefined ? {} : { groupBy: query.by }),
      },
      now,
    );
    return presentCostReport(report);
  }
}

function invalid(path: string, issue: string): ApiError {
  return new ApiError(400, 'invalid_request', undefined, [{ path, issue }]);
}
