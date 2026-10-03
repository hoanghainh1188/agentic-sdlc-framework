// Spec endpoints of an intent (task B08, D-08 B08 AC1, ADR-M39 §2.2). Every handler works on the
// caller's tenant scope.
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { intentRefSchema } from '../intents/schemas.js';
import { SPECS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import { linkSpecSchema } from './schemas.js';
import type { SpecsService } from './specs.service.js';

@Controller('v1/intents/:intent/specs')
export class SpecsController {
  constructor(@Inject(SPECS) private readonly specs: SpecsService) {}

  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
  ): Promise<Record<string, unknown>> {
    return this.specs.list(p, parseRequest(intentRefSchema, ref, 'path'));
  }

  @Post()
  @HttpCode(201)
  link(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.specs.link(
      p,
      parseRequest(intentRefSchema, ref, 'path'),
      parseRequest(linkSpecSchema, body, 'body'),
    );
  }
}
