// Admin endpoints for tenant admins (task B13, QUESTIONS #150, #151; ADR-M37 §2.1). Tenant admins
// only. Nobody grants the role to themselves, and the last active tenant admin is never removed.
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { grantTenantRole, listTenantRoles, revokeTenantRole } from '@sdlc/core';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { parseRequest } from '../validation.js';
import { actorOf } from './actor.js';
import { presentTenantRole } from './present.js';
import { grantTenantAdminSchema, historyQuerySchema, idSchema } from './schemas.js';

type Body = Record<string, unknown>;

@Controller('v1/admin/tenant-admins')
export class AdminTenantAdminsController {
  @Get()
  async list(@CurrentPrincipal() p: Principal, @Query() query: unknown): Promise<Body> {
    const history = parseRequest(historyQuerySchema, query, 'query');
    const bindings = await listTenantRoles(p.scope, actorOf(p), history.include_revoked === 'true');
    return { items: bindings.map(presentTenantRole) };
  }

  @Post()
  @HttpCode(201)
  async grant(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<Body> {
    const input = parseRequest(grantTenantAdminSchema, body, 'body');
    return presentTenantRole(await grantTenantRole(p.scope, actorOf(p), { userId: input.user_id }));
  }

  @Delete(':id')
  async revoke(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<Body> {
    return presentTenantRole(
      await revokeTenantRole(p.scope, actorOf(p), parseRequest(idSchema, id, 'path')),
    );
  }
}
