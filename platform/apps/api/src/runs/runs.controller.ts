// Run endpoints (task C11, D-08 C11 AC1, ADR-M42 §2.6): the runs of an intent, and the kill
// switch. Every handler works on the caller's tenant scope.
import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { intentRefSchema } from '../intents/schemas.js';
import { RUNS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { RunsService } from './runs.service.js';
import { runRefSchema } from './schemas.js';

@Controller('v1')
export class RunsController {
  constructor(@Inject(RUNS) private readonly runs: RunsService) {}

  @Get('intents/:intent/runs')
  list(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
  ): Promise<Record<string, unknown>> {
    return this.runs.list(p, parseRequest(intentRefSchema, ref, 'path'));
  }

  /** 202: the kill is recorded; the run stops within minutes. `already`: it was killed before. */
  @Post('runs/:run/kill')
  @HttpCode(202)
  kill(
    @CurrentPrincipal() p: Principal,
    @Param('run') run: string,
  ): Promise<Record<string, unknown>> {
    return this.runs.kill(p, parseRequest(runRefSchema, run, 'path'));
  }
}
