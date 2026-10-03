// Plan endpoints of an intent (task B09, D-08 B09 AC2, ADR-M40 §2.3). Every handler works on the
// caller's tenant scope.
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { intentRefSchema } from '../intents/schemas.js';
import { PLANS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { PlansService } from './plans.service.js';
import { submitPlanSchema } from './schemas.js';

@Controller('v1/intents/:intent/plans')
export class PlansController {
  constructor(@Inject(PLANS) private readonly plans: PlansService) {}

  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
  ): Promise<Record<string, unknown>> {
    return this.plans.list(p, parseRequest(intentRefSchema, ref, 'path'));
  }

  @Post()
  @HttpCode(201)
  submit(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.plans.submit(
      p,
      parseRequest(intentRefSchema, ref, 'path'),
      parseRequest(submitPlanSchema, body ?? {}, 'body'),
    );
  }
}
