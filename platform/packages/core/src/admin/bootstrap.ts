// One-time bootstrap of a tenant: the tenant, its first user and that user's first API token
// (task B03, QUESTIONS.md #58 and #63, ADR-M26 section 2.2). Run by the operator on the server.
// Everything else (projects, users, identities, roles, configuration) is onboarding, task B13.
import { DbError } from '../db/errors.js';
import type { PlatformDatabase } from '../db/platform-database.js';
import type { Tenant, User } from '../db/schema.js';
import { issueApiToken, type IssuedApiToken } from './tokens.js';

export const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 200;

export interface BootstrapInput {
  readonly tenantSlug: string;
  readonly tenantName: string;
  readonly adminEmail: string;
  readonly adminName: string;
  /** Default `bootstrap`. */
  readonly tokenName?: string;
  readonly lifetimeDays?: number;
  readonly now?: Date;
}

export interface BootstrapResult {
  readonly tenant: Tenant;
  readonly user: User;
  readonly token: IssuedApiToken;
}

/**
 * Creates the tenant, its first user and a token in one transaction, with the audit events
 * `tenant.created`, `user.created` and `api_token.issued`. Refuses an existing tenant slug
 * (`DbError('conflict')`), so it can never add a second "first admin" to a running tenant.
 */
export function bootstrapTenant(
  db: PlatformDatabase,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  checkInput(input);
  return db.system.createTenantWith(
    { slug: input.tenantSlug, name: input.tenantName.trim() },
    async (scope, tenant) => {
      await scope.audit.append({
        action: 'tenant.created',
        actorType: 'system',
        actorId: null,
        entityId: tenant.id,
        payload: {},
      });
      const user = await scope.users.create({
        display_name: input.adminName.trim(),
        email: input.adminEmail.trim(),
        status: 'active',
      });
      await scope.audit.append({
        action: 'user.created',
        actorType: 'system',
        actorId: null,
        entityId: user.id,
        payload: {},
      });
      const token = await issueApiToken(scope, {
        userId: user.id,
        name: input.tokenName ?? 'bootstrap',
        ...(input.lifetimeDays === undefined ? {} : { lifetimeDays: input.lifetimeDays }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      return { tenant, user, token };
    },
  );
}

function checkInput(input: BootstrapInput): void {
  if (!TENANT_SLUG_PATTERN.test(input.tenantSlug)) {
    throw new DbError('invalid_value', 'tenant slug must be lowercase letters, digits and -');
  }
  for (const [field, value] of [
    ['tenant name', input.tenantName],
    ['admin name', input.adminName],
  ] as const) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NAME) {
      throw new DbError('invalid_value', `${field} must be 1 to ${String(MAX_NAME)} characters`);
    }
  }
  if (!EMAIL_PATTERN.test(input.adminEmail.trim())) {
    throw new DbError('invalid_value', 'admin e-mail address is not valid');
  }
}
