import { sql } from 'kysely';

import type { TenantInsert, TenantRoleBinding } from '../schema.js';
import type { TenantRole } from '../vocabulary.js';
import { TenantRepository } from './base.js';
import type { RoleBindingQuery } from './role-bindings.js';

/**
 * Tenant-level roles (task B13, QUESTIONS #150, ADR-M37). Like project roles, a role is withdrawn
 * with `revoke`, never deleted; reads return active bindings only unless `includeRevoked` is set.
 */
export class TenantRoleBindingRepository extends TenantRepository {
  /** Grants a role. Fails with `conflict` while the same role is already active. */
  grant(input: TenantInsert<'tenant_role_bindings'>): Promise<TenantRoleBinding> {
    return this.run(
      this.db
        .insertInto('tenant_role_bindings')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string, query: RoleBindingQuery = {}): Promise<TenantRoleBinding | undefined> {
    return this.run(
      this.db
        .selectFrom('tenant_role_bindings')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .$if(!query.includeRevoked, (qb) => qb.where('revoked_at', 'is', null))
        .executeTakeFirst(),
    );
  }

  list(query: RoleBindingQuery = {}): Promise<TenantRoleBinding[]> {
    return this.run(
      this.db
        .selectFrom('tenant_role_bindings')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .$if(!query.includeRevoked, (qb) => qb.where('revoked_at', 'is', null))
        .orderBy('role')
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
  }

  /** True when the user holds the role now. */
  async holds(userId: string, role: TenantRole): Promise<boolean> {
    const row = await this.run(
      this.db
        .selectFrom('tenant_role_bindings')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', userId)
        .where('role', '=', role)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  /**
   * Locks the tenant's active bindings of a role until the transaction ends, and returns them.
   * Used before a revocation, so two admins cannot each remove the other and leave none.
   */
  lockActive(role: TenantRole): Promise<TenantRoleBinding[]> {
    return this.run(
      this.db
        .selectFrom('tenant_role_bindings')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('role', '=', role)
        .where('revoked_at', 'is', null)
        .orderBy('id')
        .forUpdate()
        .execute(),
    );
  }

  /**
   * Withdraws an active role. Returns the revoked binding, or undefined when no active binding
   * with this ID exists in this tenant. `at` defaults to the database clock.
   */
  revoke(id: string, at?: Date): Promise<TenantRoleBinding | undefined> {
    return this.run(
      this.db
        .updateTable('tenant_role_bindings')
        .set({ revoked_at: at ?? sql<Date>`now()` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .returningAll()
        .executeTakeFirst(),
    );
  }
}
