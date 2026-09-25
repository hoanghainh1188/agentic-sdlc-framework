import type { TenantInsert, UserIdentity } from '../schema.js';
import type { GitProvider } from '../vocabulary.js';
import { TenantRepository } from './base.js';

export class UserIdentityRepository extends TenantRepository {
  link(input: TenantInsert<'user_identities'>): Promise<UserIdentity> {
    return this.run(
      this.db
        .insertInto('user_identities')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Finds the identity of a Git host account (numeric account ID, not the login). */
  findByExternalId(provider: GitProvider, externalId: string): Promise<UserIdentity | undefined> {
    return this.run(
      this.db
        .selectFrom('user_identities')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('provider', '=', provider)
        .where('external_id', '=', externalId)
        .executeTakeFirst(),
    );
  }

  listForUser(userId: string): Promise<UserIdentity[]> {
    return this.run(
      this.db
        .selectFrom('user_identities')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', userId)
        .orderBy('provider')
        .execute(),
    );
  }
}
