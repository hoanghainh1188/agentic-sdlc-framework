// Operations that cannot be bound to one tenant (design/ADR-M09 section 2.4).
// Keep this list short and explicit. Each method must say why it needs to cross tenants.
import type { Kysely } from 'kysely';

import { translatePgError } from './errors.js';
import { assertTokenHash } from './repositories/api-tokens.js';
import type { Database, Tenant } from './schema.js';
import { parseTenantId, type TenantId } from './tenant-id.js';

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

  /** Platform admin and CLI: finds a tenant by its slug before a tenant scope exists. */
  getTenantBySlug(slug: string): Promise<Tenant | undefined> {
    return run(
      this.db.selectFrom('tenants').selectAll().where('slug', '=', slug).executeTakeFirst(),
    );
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
