// Cost report endpoint (task E04, D-08 E04 AC1, AC2, ADR-M45 §2.4). Works on the caller's tenant.
import { Controller, Get, Inject, Query } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { COST } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { CostService } from './cost.service.js';
import { costReportQuerySchema } from './schemas.js';

@Controller('v1/cost')
export class CostController {
  constructor(@Inject(COST) private readonly cost: CostService) {}

  @Get('report')
  report(
    @CurrentPrincipal() p: Principal,
    @Query() query: unknown,
  ): Promise<Record<string, unknown>> {
    return this.cost.report(p, parseRequest(costReportQuerySchema, query, 'query'));
  }
}
