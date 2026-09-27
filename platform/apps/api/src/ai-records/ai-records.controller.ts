// Project AI record endpoints (D-08 B12 AC1, ADR-M32 §2.4). Every handler works on the caller's
// tenant scope.
import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { AI_RECORDS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { AiRecordsService } from './ai-records.service.js';
import { projectSlugSchema, saveAiRecordSchema } from './schemas.js';

@Controller('v1/projects/:project/ai-record')
export class AiRecordsController {
  constructor(@Inject(AI_RECORDS) private readonly records: AiRecordsService) {}

  @Get()
  show(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
  ): Promise<Record<string, unknown>> {
    return this.records.show(p, parseRequest(projectSlugSchema, project, 'path'));
  }

  @Put()
  save(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.records.save(
      p,
      parseRequest(projectSlugSchema, project, 'path'),
      parseRequest(saveAiRecordSchema, body, 'body'),
    );
  }
}
