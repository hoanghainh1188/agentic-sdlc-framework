// Personal API tokens through the API (task B13 AC5, QUESTIONS #152, ADR-M37 §2.8).
// - A person issues, lists and revokes their own tokens.
// - A tenant admin lists and revokes anyone's tokens, and may issue a first token for another
//   user (the onboarding path). Such a token lives at most `TOKEN_FOR_OTHER_MAX_DAYS`, the audit
//   event names the issuer as its actor, and the user is told to create their own token and
//   revoke that one.
// The raw token is returned once and never stored or logged; only its hash is kept.
import type { ApiToken } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { isUuid } from '../db/tenant-id.js';
import { assertTenantAdmin, type AdminActor } from './actor.js';
import { AdminError } from './errors.js';
import { issueApiToken, revokeApiToken, type IssuedApiToken } from './tokens.js';
import { findUser } from './users.js';

/** Most days for a token a tenant admin issues for someone else (QUESTIONS #152). */
export const TOKEN_FOR_OTHER_MAX_DAYS = 7;

export interface IssueTokenRequest {
  readonly name: string;
  readonly lifetimeDays?: number;
  readonly now?: Date;
}

export interface IssuedTokenView extends IssuedApiToken {
  /** True when the token was issued for someone else than the actor. */
  readonly forOtherUser: boolean;
}

/**
 * Issues a token for `userId`. For oneself any person may; for someone else only a tenant admin,
 * and the token lives at most `TOKEN_FOR_OTHER_MAX_DAYS`.
 */
export async function issueTokenFor(
  scope: TenantScope,
  actor: AdminActor & { readonly type: 'human' },
  userId: string,
  request: IssueTokenRequest,
): Promise<IssuedTokenView> {
  const forOtherUser = actor.userId !== userId;
  return scope.transaction(async (tx) => {
    if (forOtherUser) await assertTenantAdmin(tx, actor);
    const user = await findUser(tx, userId);
    if (user.status !== 'active') throw new AdminError('user_not_active', 'user is disabled');
    const issued = await issueApiToken(tx, {
      userId: user.id,
      name: request.name,
      actor,
      ...(forOtherUser ? { maxLifetimeDays: TOKEN_FOR_OTHER_MAX_DAYS } : {}),
      ...(request.lifetimeDays === undefined ? {} : { lifetimeDays: request.lifetimeDays }),
      ...(request.now === undefined ? {} : { now: request.now }),
    });
    return { ...issued, forOtherUser };
  });
}

/** Tokens of `userId`: one's own, or anyone's for a tenant admin. Never the token or its hash. */
export async function listTokensOf(
  scope: TenantScope,
  actor: AdminActor & { readonly type: 'human' },
  userId: string,
): Promise<ApiToken[]> {
  if (actor.userId !== userId) await assertTenantAdmin(scope, actor);
  const user = await findUser(scope, userId);
  return scope.apiTokens.listForUser(user.id);
}

/**
 * Revokes a token of `userId`: one's own, or anyone's for a tenant admin. Idempotent like
 * `revokeApiToken`. A token of another user, or unknown, gives `token_not_found`.
 */
export async function revokeTokenOf(
  scope: TenantScope,
  actor: AdminActor & { readonly type: 'human' },
  userId: string,
  tokenId: string,
  now?: Date,
): Promise<ApiToken> {
  return scope.transaction(async (tx) => {
    if (actor.userId !== userId) await assertTenantAdmin(tx, actor);
    const token = isUuid(tokenId) ? await tx.apiTokens.getById(tokenId) : undefined;
    if (token?.user_id !== userId) {
      throw new AdminError('token_not_found', 'no token with this ID for the user');
    }
    const revoked = await revokeApiToken(tx, token.id, now, actor);
    if (!revoked) throw new AdminError('token_not_found', 'no token with this ID for the user');
    return revoked;
  });
}
