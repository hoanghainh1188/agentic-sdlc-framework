import { sql } from 'kysely';

import type { RoleBinding, TenantInsert } from '../schema.js';
import { TenantRepository } from './base.js';
import { lockProjectRoles } from './locks.js';

export interface RoleBindingQuery {
  /** Also return revoked bindings (history). Default: active bindings only. */
  readonly includeRevoked?: boolean;
}

/**
 * 2+N role bindings per project. A role is withdrawn with `revoke`, never deleted (D-05 D7).
 * Reads return active bindings only, unless `includeRevoked` is set: approval checks
 * (`canApprove`, B01) must never see a revoked role.
 */
export class RoleBindingRepository extends TenantRepository {
  /** Grants a role. Fails with `conflict` while the same role is already active. */
  grant(input: TenantInsert<'role_bindings'>): Promise<RoleBinding> {
    return this.run(
      this.db
        .insertInto('role_bindings')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /**
   * Holds the project's role-grant lock until the transaction ends (B13). Only inside a
   * transaction; grants that check other roles first take it before they read.
   */
  async lockForGrant(projectId: string): Promise<void> {
    if (!this.db.isTransaction) throw new Error('lockForGrant must run inside a transaction');
    await this.run(lockProjectRoles(this.db, projectId));
  }

  getById(id: string, query: RoleBindingQuery = {}): Promise<RoleBinding | undefined> {
    return this.run(
      this.db
        .selectFrom('role_bindings')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .$if(!query.includeRevoked, (qb) => qb.where('revoked_at', 'is', null))
        .executeTakeFirst(),
    );
  }

  listForProject(projectId: string, query: RoleBindingQuery = {}): Promise<RoleBinding[]> {
    return this.run(
      this.db
        .selectFrom('role_bindings')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .$if(!query.includeRevoked, (qb) => qb.where('revoked_at', 'is', null))
        .orderBy('role')
        .orderBy('user_id')
        .orderBy('created_at')
        .execute(),
    );
  }

  listForUser(userId: string, query: RoleBindingQuery = {}): Promise<RoleBinding[]> {
    return this.run(
      this.db
        .selectFrom('role_bindings')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', userId)
        .$if(!query.includeRevoked, (qb) => qb.where('revoked_at', 'is', null))
        .orderBy('project_id')
        .orderBy('role')
        .orderBy('created_at')
        .execute(),
    );
  }

  /**
   * Withdraws an active role. Returns the revoked binding, or undefined when no active binding
   * with this ID exists in this tenant (unknown, another tenant's, or already revoked).
   * The same role can be granted again afterwards; it gets a new row.
   * `at` defaults to the database clock, which also sets `created_at`.
   */
  revoke(id: string, at?: Date): Promise<RoleBinding | undefined> {
    return this.run(
      this.db
        .updateTable('role_bindings')
        .set({ revoked_at: at ?? sql<Date>`now()` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .returningAll()
        .executeTakeFirst(),
    );
  }
}
