import { sql } from 'kysely';

import type { TenantInsert, User } from '../schema.js';
import type { UserStatus } from '../vocabulary.js';
import { TenantRepository } from './base.js';

/** Fields an admin may change (B13). The ID and tenant never change. */
export interface UserUpdate {
  readonly display_name?: string;
  readonly email?: string;
}

export class UserRepository extends TenantRepository {
  create(input: TenantInsert<'users'>): Promise<User> {
    return this.run(
      this.db
        .insertInto('users')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string): Promise<User | undefined> {
    return this.run(
      this.db
        .selectFrom('users')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /** Case-insensitive, like the unique index `users_tenant_id_email_key`. */
  getByEmail(email: string): Promise<User | undefined> {
    return this.run(
      this.db
        .selectFrom('users')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where(sql<string>`lower(email)`, '=', email.toLowerCase())
        .executeTakeFirst(),
    );
  }

  list(): Promise<User[]> {
    return this.run(
      this.db
        .selectFrom('users')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .orderBy('email')
        .execute(),
    );
  }

  /** Returns the updated user, or undefined when the user is not in this tenant. */
  setStatus(id: string, status: UserStatus): Promise<User | undefined> {
    return this.run(
      this.db
        .updateTable('users')
        .set({ status })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );
  }

  /** Returns the updated user, or undefined when the user is not in this tenant. */
  update(id: string, changes: UserUpdate): Promise<User | undefined> {
    return this.run(
      this.db
        .updateTable('users')
        .set({ ...changes })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );
  }
}
