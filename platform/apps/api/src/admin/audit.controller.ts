// `GET /v1/admin/audit/verify`: the tenant's audit hash chain, for tenant admins (task B13 AC5,
// D-02 FR-41, ADR-M37 §2.8). A broken chain is a result (200, `ok: false`), not an error.
import { Controller, Get } from '@nestjs/common';
import { verifyTenantAudit } from '@sdlc/core';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { actorOf } from './actor.js';
import { presentChain } from './present.js';

@Controller('v1/admin/audit')
export class AdminAuditController {
  @Get('verify')
  async verify(@CurrentPrincipal() p: Principal): Promise<Record<string, unknown>> {
    return presentChain(p.tenantId, await verifyTenantAudit(p.scope, actorOf(p)));
  }
}
