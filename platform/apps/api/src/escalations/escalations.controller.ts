// Escalation endpoints (D-08 B11 AC5, design/ADR-M28 §2.7). Every handler works on the caller's
// tenant scope. The CLI commands `sdlc escalation …` come with B04 (QUESTIONS #77).
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { ESCALATIONS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { EscalationsService } from './escalations.service.js';
import {
  escalationCodeSchema,
  escalationDecisionSchema,
  listEscalationsSchema,
} from './schemas.js';

@Controller('v1/escalations')
export class EscalationsController {
  constructor(@Inject(ESCALATIONS) private readonly escalations: EscalationsService) {}

  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query() query: unknown,
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.escalations.list(p, parseRequest(listEscalationsSchema, query, 'query'));
  }

  @Get(':code')
  show(
    @CurrentPrincipal() p: Principal,
    @Param('code') code: string,
  ): Promise<Record<string, unknown>> {
    return this.escalations.show(p, parseRequest(escalationCodeSchema, code, 'path'));
  }

  @Post(':code/ack')
  @HttpCode(200)
  acknowledge(
    @CurrentPrincipal() p: Principal,
    @Param('code') code: string,
  ): Promise<Record<string, unknown>> {
    return this.escalations.acknowledge(p, parseRequest(escalationCodeSchema, code, 'path'));
  }

  @Post(':code/decisions')
  @HttpCode(201)
  decide(
    @CurrentPrincipal() p: Principal,
    @Param('code') code: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.escalations.decide(
      p,
      parseRequest(escalationCodeSchema, code, 'path'),
      parseRequest(escalationDecisionSchema, body, 'body'),
    );
  }
}
