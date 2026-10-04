// Gate waiting-time metrics endpoint (task E06, D-08 E06 AC1, ADR-M47). Works on the caller's tenant.
import { Controller, Get, Inject, Query } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { METRICS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { MetricsService } from './metrics.service.js';
import { gateMetricsQuerySchema } from './schemas.js';

@Controller('v1/metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsService) {}

  @Get('gates')
  gates(
    @CurrentPrincipal() p: Principal,
    @Query() query: unknown,
  ): Promise<Record<string, unknown>> {
    return this.metrics.gates(p, parseRequest(gateMetricsQuerySchema, query, 'query'));
  }
}
