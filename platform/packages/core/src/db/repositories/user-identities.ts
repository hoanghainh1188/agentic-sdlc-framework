import { sql } from 'kysely';

import type { TenantInsert, UserIdentity } from '../schema.js';
import type { GitProvider } from '../vocabulary.js';
import { TenantRepository } from './base.js';

export interface UserIdentityQuery {
  /** Also return unlinked identities (history). Default: linked identities only. */
  readonly includeUnlinked?: boolean;
}

/**
 * Git host accounts of users (D-05 section 6.1). Matched by the numeric account ID only, never
 * by the login (QUESTIONS #45). An identity is unlinked with `unlink`, never deleted (B13); reads
 * return linked identities only unless `includeUnlinked` is set, so an unlinked account never
 * decides a gate or gets mentioned.
 */
export class UserIdentityRepository extends TenantRepository {
  /** Links an account. Fails with `conflict` while the account is linked in this tenant. */
  link(input: TenantInsert<'user_identities'>): Promise<UserIdentity> {
    return this.run(
      this.db
        .insertInto('user_identities')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string, query: UserIdentityQuery = {}): Promise<UserIdentity | undefined> {
    return this.run(
      this.db
        .selectFrom('user_identities')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .$if(!query.includeUnlinked, (qb) => qb.where('unlinked_at', 'is', null))
        .executeTakeFirst(),
    );
  }

  /** Finds the linked identity of a Git host account (numeric account ID, not the login). */
  findByExternalId(provider: GitProvider, externalId: string): Promise<UserIdentity | undefined> {
    return this.run(
      this.db
        .selectFrom('user_identities')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('provider', '=', provider)
        .where('external_id', '=', externalId)
        .where('unlinked_at', 'is', null)
        .executeTakeFirst(),
    );
  }

  listForUser(userId: string, query: UserIdentityQuery = {}): Promise<UserIdentity[]> {
    return this.run(
      this.db
        .selectFrom('user_identities')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', userId)
        .$if(!query.includeUnlinked, (qb) => qb.where('unlinked_at', 'is', null))
        .orderBy('provider')
        .orderBy('created_at')
        .execute(),
    );
  }

  /**
   * Unlinks a linked identity. Returns it, or undefined when no linked identity with this ID
   * exists in this tenant (unknown, another tenant's, or already unlinked).
   * `at` defaults to the database clock, which also sets `created_at`.
   */
  unlink(id: string, at?: Date): Promise<UserIdentity | undefined> {
    return this.run(
      this.db
        .updateTable('user_identities')
        .set({ unlinked_at: at ?? sql<Date>`now()` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('unlinked_at', 'is', null)
        .returningAll()
        .executeTakeFirst(),
    );
  }
}
