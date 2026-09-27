// Operations that cannot be bound to one tenant (design/ADR-M09 section 2.4).
// Keep this list short and explicit. Each method must say why it needs to cross tenants.
import { sql, type Kysely } from 'kysely';

import { translatePgError } from './errors.js';
import { assertTokenHash } from './repositories/api-tokens.js';
import type { Database, Tenant } from './schema.js';
import { parseTenantId, type TenantId } from './tenant-id.js';
import { TenantScope } from './tenant-scope.js';

export interface NewTenant {
  readonly slug: string;
  readonly name: string;
  readonly monthlyBudgetUsd?: string | null;
}

export interface ResolvedApiToken {
  readonly tenantId: TenantId;
  readonly userId: string;
  readonly tokenId: string;
}

export class SystemScope {
  /** @internal Use `PlatformDatabase.system`. */
  constructor(private readonly db: Kysely<Database>) {}

  /** Platform admin: creates a tenant. Tenants are the root of isolation, so no tenant scope applies. */
  createTenant(input: NewTenant): Promise<Tenant> {
    return run(
      this.db
        .insertInto('tenants')
        .values({
          slug: input.slug,
          name: input.name,
          monthly_budget_usd: input.monthlyBudgetUsd ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /**
   * One-time bootstrap (task B03, ADR-M26): creates a tenant and runs `work` with a scope bound to
   * it, in the same transaction. The tenant row, its first user, token and audit events commit or
   * roll back together. Fails with `DbError('conflict')` when the slug is taken.
   */
  createTenantWith<T>(
    input: NewTenant,
    work: (scope: TenantScope, tenant: Tenant) => Promise<T>,
  ): Promise<T> {
    return run(
      this.db.transaction().execute(async (trx) => {
        const tenant = await trx
          .insertInto('tenants')
          .values({
            slug: input.slug,
            name: input.name,
            monthly_budget_usd: input.monthlyBudgetUsd ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return work(new TenantScope(trx, parseTenantId(tenant.id)), tenant);
      }),
    );
  }

  /** Platform admin and CLI: finds a tenant by its slug before a tenant scope exists. */
  getTenantBySlug(slug: string): Promise<Tenant | undefined> {
    return run(
      this.db.selectFrom('tenants').selectAll().where('slug', '=', slug).executeTakeFirst(),
    );
  }

  /** Operator commands (`sdlc audit verify`): every tenant, ordered by slug. */
  listTenants(): Promise<Tenant[]> {
    return run(this.db.selectFrom('tenants').selectAll().orderBy('slug').execute());
  }

  getTenant(tenantId: TenantId): Promise<Tenant | undefined> {
    return run(
      this.db
        .selectFrom('tenants')
        .selectAll()
        .where('id', '=', parseTenantId(tenantId))
        .executeTakeFirst(),
    );
  }

  /** Health check (task B03): true when the database answers. Reads no table. */
  async ping(): Promise<true> {
    await run(sql`SELECT 1`.execute(this.db));
    return true;
  }

  /**
   * Authentication (task B03): the tenant is only known after the token is found, so this lookup
   * crosses tenants. Takes the SHA-256 hash, never the token. Returns undefined unless the token
   * is not revoked, not expired, and its user and tenant are active.
   */
  async resolveApiToken(
    tokenHash: string,
    now: Date = new Date(),
  ): Promise<ResolvedApiToken | undefined> {
    assertTokenHash(tokenHash);
    const row = await run(
      this.db
        .selectFrom('api_tokens as t')
        .innerJoin('users as u', (join) =>
          join.onRef('u.tenant_id', '=', 't.tenant_id').onRef('u.id', '=', 't.user_id'),
        )
        .innerJoin('tenants as tn', 'tn.id', 't.tenant_id')
        .select(['t.id as token_id', 't.tenant_id', 't.user_id'])
        .where('t.token_hash', '=', tokenHash)
        .where('t.revoked_at', 'is', null)
        .where('t.expires_at', '>', now)
        .where('u.status', '=', 'active')
        .where('tn.status', '=', 'active')
        .executeTakeFirst(),
    );
    return row
      ? { tenantId: parseTenantId(row.tenant_id), userId: row.user_id, tokenId: row.token_id }
      : undefined;
  }
}

async function run<T>(statement: Promise<T>): Promise<T> {
  try {
    return await statement;
  } catch (error) {
    return translatePgError(error);
  }
}
