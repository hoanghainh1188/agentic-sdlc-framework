// `sdlc audit verify` through the API for tenant admins (task B13 AC5, ADR-M37 §2.8). The
// operator keeps the database path (`sdlc ops audit verify`) for when the API is down.
import type { ChainState } from '../audit/hash-chain.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { assertTenantAdmin, type AdminActor } from './actor.js';

/** Checks the caller's tenant chain (D-05 §7.3). Tenant admins only. */
export async function verifyTenantAudit(
  scope: TenantScope,
  actor: AdminActor,
): Promise<ChainState> {
  await assertTenantAdmin(scope, actor);
  return scope.audit.verify();
}
