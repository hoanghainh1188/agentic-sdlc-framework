// Gate waiting-time metrics (task E06, D-02 FR-12, D-08 E06, ADR-M47). The whole tenant: tenant
// admins only; one project: a tenant admin or a role in `access.metrics_read_roles` (no role on the
// project → 404, another role → 403, QUESTIONS #206).
import {
  buildAgentMetrics,
  buildGateMetrics,
  checkAgentMetricsRange,
  checkGateMetricsRange,
  resolveAgentMetricsRange,
  resolveGateMetricsRange,
} from '@sdlc/core';

import type { Principal } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';
import { presentAgentMetrics, presentGateMetrics } from './present.js';
import type { AgentMetricsQuery, GateMetricsQuery } from './schemas.js';

export class MetricsService {
  constructor(private readonly now: () => Date) {}

  async gates(p: Principal, query: GateMetricsQuery): Promise<Record<string, unknown>> {
    const now = this.now();
    const bounds = {
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    };
    const issue = checkGateMetricsRange(resolveGateMetricsRange(bounds, now));
    if (issue !== undefined) {
      throw new ApiError(400, 'invalid_request', undefined, [{ path: 'query.to', issue }]);
    }
    const metrics = await buildGateMetrics(
      p.scope,
      { userId: p.userId },
      {
        ...bounds,
        ...(query.project === undefined ? {} : { projectSlug: query.project }),
        ...(query.gate === undefined ? {} : { gate: query.gate }),
        ...(query.mode === undefined ? {} : { mode: query.mode }),
        ...(query.risk === undefined ? {} : { riskTier: query.risk }),
      },
      now,
    );
    return presentGateMetrics(metrics);
  }

  /** The agent efficiency report (task V13, ADR-M79). */
  async agents(p: Principal, query: AgentMetricsQuery): Promise<Record<string, unknown>> {
    const now = this.now();
    const bounds = {
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    };
    const issue = checkAgentMetricsRange(resolveAgentMetricsRange(bounds, now));
    if (issue !== undefined) {
      throw new ApiError(400, 'invalid_request', undefined, [{ path: 'query.to', issue }]);
    }
    const metrics = await buildAgentMetrics(
      p.scope,
      { userId: p.userId },
      {
        ...bounds,
        ...(query.project === undefined ? {} : { projectSlug: query.project }),
        ...(query.agent === undefined ? {} : { agentKey: query.agent }),
        ...(query.model === undefined ? {} : { model: query.model }),
      },
      now,
    );
    return presentAgentMetrics(metrics);
  }
}
