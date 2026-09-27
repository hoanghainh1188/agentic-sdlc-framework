// Personal API tokens (design/D-05 section 6.1, D-08 B03 AC1, ADR-M26 section 2.3).
// A token is shown once, when it is issued. Only its SHA-256 hash is stored.
import { randomBytes } from 'node:crypto';

import { DbError } from '../db/errors.js';
import { hashApiToken } from '../db/repositories/api-tokens.js';
import type { ApiToken } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { isUuid } from '../db/tenant-id.js';

/** Prefix of every platform token, so secret scanners (Gitleaks rule `sdlc-api-token`) find leaks. */
export const API_TOKEN_PREFIX = 'sdlc_pat_';

/** 32 random bytes in base64url: 43 characters after the prefix. */
export const API_TOKEN_PATTERN = /^sdlc_pat_[A-Za-z0-9_-]{43}$/;

/** [Proposal] pilot defaults (ADR-M26 D6). Platform settings, not project configuration. */
export const API_TOKEN_DEFAULT_LIFETIME_DAYS = 90;
export const API_TOKEN_MAX_LIFETIME_DAYS = 365;

/** Token names are short labels such as `laptop-harry`: a code, never free text. */
export const API_TOKEN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** True when `value` has the shape of a platform token. Checked before any database lookup. */
export function isApiTokenFormat(value: string): boolean {
  return API_TOKEN_PATTERN.test(value);
}

export interface IssueApiToken {
  readonly userId: string;
  readonly name: string;
  /** Default `API_TOKEN_DEFAULT_LIFETIME_DAYS`; at most `API_TOKEN_MAX_LIFETIME_DAYS`. */
  readonly lifetimeDays?: number;
  readonly now?: Date;
}

export interface IssuedApiToken {
  /** The raw token. Show it once; never log or store it. */
  readonly token: string;
  readonly record: ApiToken;
}

/**
 * Issues a token for an active user of the tenant and appends `api_token.issued`, in one
 * transaction. Throws `DbError('invalid_value')` for a bad name or lifetime, or an inactive user.
 */
export async function issueApiToken(
  scope: TenantScope,
  input: IssueApiToken,
): Promise<IssuedApiToken> {
  if (!API_TOKEN_NAME_PATTERN.test(input.name)) {
    throw new DbError('invalid_value', 'token name must be a short code (letters, digits, _ . -)');
  }
  const days = input.lifetimeDays ?? API_TOKEN_DEFAULT_LIFETIME_DAYS;
  if (!Number.isSafeInteger(days) || days < 1 || days > API_TOKEN_MAX_LIFETIME_DAYS) {
    throw new DbError(
      'invalid_value',
      `token lifetime must be 1 to ${String(API_TOKEN_MAX_LIFETIME_DAYS)} days`,
    );
  }
  const now = input.now ?? new Date();
  const token = generateApiToken();
  const record = await scope.transaction(async (tx) => {
    const user = await tx.users.getById(input.userId);
    if (user?.status !== 'active') {
      throw new DbError('invalid_value', 'tokens are issued to active users of the tenant only');
    }
    const created = await tx.apiTokens.create({
      user_id: user.id,
      name: input.name,
      token_hash: hashApiToken(token),
      expires_at: new Date(now.getTime() + days * DAY_MS),
    });
    await tx.audit.append({
      action: 'api_token.issued',
      actorType: 'system',
      actorId: null,
      entityId: created.id,
      payload: { user_id: created.user_id },
    });
    return created;
  });
  return { token, record };
}

/**
 * Revokes a token. Idempotent: the first revocation time is kept and `api_token.revoked` is
 * appended only once. Returns undefined when the token is not in this tenant.
 */
export function revokeApiToken(
  scope: TenantScope,
  tokenId: string,
  now: Date = new Date(),
): Promise<ApiToken | undefined> {
  if (!isUuid(tokenId)) return Promise.resolve(undefined);
  return scope.transaction(async (tx) => {
    const before = await tx.apiTokens.getById(tokenId);
    if (!before) return undefined;
    if (before.revoked_at !== null) return before;
    const revoked = await tx.apiTokens.revoke(tokenId, now);
    await tx.audit.append({
      action: 'api_token.revoked',
      actorType: 'system',
      actorId: null,
      entityId: before.id,
      payload: { user_id: before.user_id },
    });
    return revoked;
  });
}
