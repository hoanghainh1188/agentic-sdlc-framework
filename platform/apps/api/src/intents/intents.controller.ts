// Intent and gate endpoints (D-08 B03 AC3). Every handler works on the caller's tenant scope.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { INTENTS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { IntentPage, IntentsService } from './intents.service.js';
import type { IntentBody } from './present.js';
import {
  createIntentSchema,
  decisionSchema,
  gateSchema,
  intentRefSchema,
  listIntentsSchema,
} from './schemas.js';

@Controller('v1/intents')
export class IntentsController {
  constructor(@Inject(INTENTS) private readonly intents: IntentsService) {}

  @Post()
  @HttpCode(201)
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<IntentBody> {
    return this.intents.create(p, parseRequest(createIntentSchema, body, 'body'));
  }

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() query: unknown): Promise<IntentPage> {
    return this.intents.list(p, parseRequest(listIntentsSchema, query, 'query'));
  }

  @Get(':intent')
  show(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
  ): Promise<Record<string, unknown>> {
    return this.intents.show(p, parseRequest(intentRefSchema, ref, 'path'));
  }

  @Post(':intent/gates/:gate/decisions')
  @HttpCode(201)
  decide(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Param('gate') gate: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.intents.decide(
      p,
      parseRequest(intentRefSchema, ref, 'path'),
      parseRequest(gateSchema, gate, 'path'),
      parseRequest(decisionSchema, body, 'body'),
    );
  }
}
