// Dashboard sign-in sessions (task U05, design/ADR-M73 §2.2, MVP1-UI-SCOPE §5.1–§5.2).
//
// - A person signs in with GitHub; the api finds the user by (tenant, `github`, numeric account ID)
//   among the linked identities, active users only (`findSignInUser`).
// - Every sign-in makes a new session ID and a new 32-byte secret (no session fixation). The secret
//   goes to the browser's cookie only; the database keeps its SHA-256.
// - Sessions end at sign-out, sign out everywhere, by a tenant admin, when the user is disabled and
//   when the identity is unlinked (see `admin/users.ts`). Each end is audited with a reason code;
//   the audit log never holds a session ID.
import { createHash, createHmac, randomBytes } from 'node:crypto';

import { assertTenantAdmin, auditActor, type AdminActor } from '../admin/actor.js';
import { AdminError } from '../admin/errors.js';
import { isUuid } from '../db/tenant-id.js';
import { hashSessionSecret } from '../db/repositories/web-sessions.js';
import type { User, UserIdentity, WebSession, WebSessionEndReason } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** The session secret in the cookie: 32 random bytes, base64url (43 characters). */
export const WEB_SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The CSRF token of a session (U06, ADR-M73 §2.3, QUESTIONS #410): HMAC-SHA256 of a fixed label
 * with the session secret as the key, base64url. The api gives it to the page from the session
 * cookie (`GET /v1/auth/session`) without storing it; the database keeps its SHA-256. A page on
 * another site can read neither the `HttpOnly` cookie nor the token.
 */
export function deriveCsrfToken(sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update('sdlc-csrf-1', 'utf8').digest('base64url');
}

/** SHA-256 of a CSRF token, lowercase hex: what `web_sessions.csrf_sha256` holds. */
export function hashCsrfToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The GitHub numeric account ID, as `user_identities.external_id` stores it (QUESTIONS #45). */
const GITHUB_ID = /^[1-9][0-9]{0,19}$/;

export interface SignInUser {
  readonly user: User;
  readonly identity: UserIdentity;
}

/**
 * The active user whose linked GitHub identity has this numeric account ID, or undefined. The
 * caller refuses every undefined with the same answer (ADR-M73 §2.2): no account, unlinked,
 * disabled.
 */
export async function findSignInUser(
  scope: TenantScope,
  githubAccountId: string,
): Promise<SignInUser | undefined> {
  if (!GITHUB_ID.test(githubAccountId)) return undefined;
  const identity = await scope.userIdentities.findByExternalId('github', githubAccountId);
  if (!identity) return undefined;
  const user = await scope.users.getById(identity.user_id);
  if (user?.status !== 'active') return undefined;
  return { user, identity };
}

export interface StartWebSession {
  readonly userId: string;
  readonly identityId: string;
  readonly now: Date;
  /** The absolute lifetime (setting `SDLC_API_SESSION_MAX_HOURS`). */
  readonly maxAgeMs: number;
}

export interface StartedWebSession {
  readonly session: WebSession;
  /** Goes to the cookie only: never logged, never stored. */
  readonly secret: string;
}

/** Opens a new session and audits `web_session.started`, in one transaction. */
export async function startWebSession(
  scope: TenantScope,
  input: StartWebSession,
): Promise<StartedWebSession> {
  if (!Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs <= 0) {
    throw new RangeError('maxAgeMs must be a positive integer');
  }
  const secret = randomBytes(32).toString('base64url');
  return scope.transaction(async (tx) => {
    const session = await tx.webSessions.create({
      user_id: input.userId,
      identity_id: input.identityId,
      secret_sha256: hashSessionSecret(secret),
      csrf_sha256: hashCsrfToken(deriveCsrfToken(secret)),
      last_seen_at: input.now,
      expires_at: new Date(input.now.getTime() + input.maxAgeMs),
    });
    await tx.audit.append({
      action: 'web_session.started',
      actorType: 'human',
      actorId: input.userId,
      entityId: input.userId,
      payload: { provider: 'github' },
      occurredAt: input.now,
    });
    return { session, secret };
  });
}

/** Ends the caller's own session (`sign_out`). Ending an ended session changes nothing. */
export async function endOwnWebSession(
  scope: TenantScope,
  userId: string,
  sessionId: string,
  now: Date,
): Promise<void> {
  await scope.transaction(async (tx) => {
    const ended = await tx.webSessions.end(sessionId, 'sign_out', now);
    if (!ended) return;
    if (ended.user_id !== userId) throw new Error('session of another user');
    await auditEnded(tx, { type: 'human', userId }, userId, 'sign_out', 1, now);
  });
}

/** Sign out everywhere: ends every session of the caller (`all`). Returns how many ended. */
export async function endAllOwnWebSessions(
  scope: TenantScope,
  userId: string,
  now: Date,
): Promise<number> {
  return scope.transaction(async (tx) => {
    const count = await tx.webSessions.endAllForUser(userId, 'all', now);
    if (count > 0) await auditEnded(tx, { type: 'human', userId }, userId, 'all', count, now);
    return count;
  });
}

/** A tenant admin (or the operator) signs a person out everywhere (`admin`). */
export async function endUserWebSessions(
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  now: Date,
): Promise<number> {
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const user = isUuid(userId) ? await tx.users.getById(userId) : undefined;
    if (!user) throw new AdminError('user_not_found', 'user not found');
    const count = await tx.webSessions.endAllForUser(user.id, 'admin', now);
    if (count > 0) await auditEnded(tx, actor, user.id, 'admin', count, now);
    return count;
  });
}

/**
 * Inside the transaction of an admin change: ends the sessions a disabled user or an unlinked
 * identity leaves behind. Audited only when one ended.
 */
export async function endSessionsAfterAdminChange(
  tx: TenantScope,
  actor: AdminActor,
  change:
    | { readonly kind: 'user_disabled'; readonly userId: string }
    | { readonly kind: 'identity_unlinked'; readonly userId: string; readonly identityId: string },
  now: Date,
): Promise<number> {
  const count =
    change.kind === 'user_disabled'
      ? await tx.webSessions.endAllForUser(change.userId, 'user_disabled', now)
      : await tx.webSessions.endAllForIdentity(change.identityId, 'identity_unlinked', now);
  if (count > 0) await auditEnded(tx, actor, change.userId, change.kind, count, now);
  return count;
}

/**
 * Audits a session ended by a new sign-in in the same browser (`replaced`, no session fixation).
 * The session itself is ended by `SystemScope.endWebSessionBySecret`, which finds its tenant.
 */
export async function auditReplacedWebSession(
  scope: TenantScope,
  userId: string,
  now: Date,
): Promise<void> {
  await auditEnded(scope, { type: 'system' }, userId, 'replaced', 1, now);
}

async function auditEnded(
  tx: TenantScope,
  actor: AdminActor,
  userId: string,
  reason: WebSessionEndReason,
  count: number,
  now: Date,
): Promise<void> {
  await tx.audit.append({
    action: 'web_session.ended',
    ...auditActor(actor),
    entityId: userId,
    payload: { reason, count },
    occurredAt: now,
  });
}
