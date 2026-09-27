// The authenticated caller of a request. The tenant comes from the token only (D-08 B03 AC2):
// no header, path or body value can choose another tenant.
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { TenantId, TenantScope } from '@sdlc/core';

export interface Principal {
  readonly tenantId: TenantId;
  readonly userId: string;
  readonly tokenId: string;
  /** Repositories bound to the caller's tenant. The only way handlers reach data. */
  readonly scope: TenantScope;
}

export interface AuthenticatedRequest {
  principal?: Principal;
}

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    // The guard runs first on every non-public route; reaching here without one is a bug.
    if (!principal) throw new Error('route has no principal: is it marked public by mistake?');
    return principal;
  },
);
