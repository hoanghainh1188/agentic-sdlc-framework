// The caller's own personal API tokens (task B13 AC5, ADR-M37 §2.8). `DELETE current` revokes the
// token of this request: `sdlc logout` calls it before it deletes the saved login (ADR-M36 §4).
// A new token is in the response body once and never logged.
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { issueTokenFor, listTokensOf, revokeTokenOf } from '@sdlc/core';

import { actorOf } from '../admin/actor.js';
import { presentIssuedToken, presentToken } from '../admin/present.js';
import { idSchema, issueTokenSchema } from '../admin/schemas.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { CLOCK } from '../tokens.js';
import { parseRequest } from '../validation.js';

type Body = Record<string, unknown>;

@Controller('v1/me/tokens')
export class MeTokensController {
  constructor(@Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal): Promise<Body> {
    const tokens = await listTokensOf(p.scope, actorOf(p), p.userId);
    return { items: tokens.map(presentToken) };
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<Body> {
    const input = parseRequest(issueTokenSchema, body, 'body');
    const issued = await issueTokenFor(p.scope, actorOf(p), p.userId, {
      name: input.name,
      now: this.now(),
      ...(input.days === undefined ? {} : { lifetimeDays: input.days }),
    });
    return presentIssuedToken(issued);
  }

  @Delete('current')
  async revokeCurrent(@CurrentPrincipal() p: Principal): Promise<Body> {
    return presentToken(await revokeTokenOf(p.scope, actorOf(p), p.userId, p.tokenId, this.now()));
  }

  @Delete(':id')
  async revoke(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<Body> {
    const tokenId = parseRequest(idSchema, id, 'path');
    return presentToken(await revokeTokenOf(p.scope, actorOf(p), p.userId, tokenId, this.now()));
  }
}
