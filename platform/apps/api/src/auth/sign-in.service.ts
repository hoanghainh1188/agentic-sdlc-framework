// Dashboard sign-in with GitHub (task U05, design/ADR-M73 §2.2, MVP1-UI-SCOPE §5.1–§5.2).
//
// 1. `start`: a pending sign-in (state, PKCE verifier, tenant) in memory; the browser gets the
//    handle in the pre-login cookie and goes to GitHub.
// 2. `callback`: the cookie's handle and the returned `state` must match; the code is exchanged
//    with the verifier; the numeric account ID is read; the person's GitHub token is revoked at
//    once (QUESTIONS #388). The user is the active user with a linked identity (tenant, `github`,
//    account ID). Every refusal looks the same to the browser (`refused`); only the log's cause
//    differs, and it holds codes only.
// 3. A session cookie the browser sent is ended (`replaced`), never reused: a new session ID and
//    secret at every sign-in (no session fixation).
import {
  auditReplacedWebSession,
  findSignInUser,
  hashSessionSecret,
  parseTenantId,
  startWebSession,
  TENANT_SLUG_PATTERN,
  type PlatformDatabase,
  type PlatformLogger,
} from '@sdlc/core';
import { WebSignInError, type RedactedSecret, type WebSignInProvider } from '@sdlc/contracts';

import { OAUTH_STATE_TTL_MS, type OAuthStates } from './oauth-states.js';

export interface SignInSettings {
  /** `<public origin>/v1/auth/github/callback`, as listed in the GitHub App. */
  readonly callbackUrl: string;
  readonly maxAgeMs: number;
}

export interface SignInDeps {
  readonly db: PlatformDatabase;
  readonly provider: WebSignInProvider;
  readonly states: OAuthStates;
  readonly settings: SignInSettings;
  readonly now: () => Date;
  readonly log: PlatformLogger;
}

/** What the browser is told. `unavailable`: GitHub or the App's secret could not be used. */
export type SignInRefusal = 'refused' | 'unavailable';

export type StartResult =
  | {
      readonly ok: true;
      readonly redirect: string;
      readonly handle: string;
      readonly ttlSeconds: number;
    }
  | { readonly ok: false; readonly refusal: SignInRefusal };

export type CallbackResult =
  | { readonly ok: true; readonly secret: string; readonly maxAgeSeconds: number }
  | { readonly ok: false; readonly refusal: SignInRefusal };

export interface CallbackInput {
  readonly handle: string | undefined;
  readonly state: string | undefined;
  readonly code: string | undefined;
  /** GitHub's `error` parameter (for example the person denied access). */
  readonly error: string | undefined;
  /** The session cookie the browser sent, if any: ended, never reused. */
  readonly previousSecret: string | undefined;
}

const CODE = /^[A-Za-z0-9_.-]{1,255}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;

export class SignInService {
  constructor(private readonly deps: SignInDeps) {}

  async start(tenantSlug: string): Promise<StartResult> {
    // An unknown or badly formed tenant is not told apart here: the callback refuses it, so the
    // redirect never reveals which tenants exist.
    const slug = TENANT_SLUG_PATTERN.test(tenantSlug) ? tenantSlug : '-';
    const pending = this.deps.states.start(slug);
    try {
      const redirect = await this.deps.provider.authorizeUrl({
        state: pending.state,
        codeChallenge: pending.codeChallenge,
        redirectUri: this.deps.settings.callbackUrl,
      });
      return {
        ok: true,
        redirect,
        handle: pending.handle,
        ttlSeconds: OAUTH_STATE_TTL_MS / 1000,
      };
    } catch (error) {
      return this.#refuse('unavailable', errorCode(error));
    }
  }

  async callback(input: CallbackInput): Promise<CallbackResult> {
    if (input.handle === undefined) return this.#refuse('refused', 'no_oauth_cookie');
    // Only a matching state uses the pending sign-in up: a link made by someone else cannot
    // cancel the person's sign-in (security review of U05, LOW-1).
    if (input.state === undefined || !STATE.test(input.state)) {
      return this.#refuse('refused', 'bad_state');
    }
    const pending = this.deps.states.take(input.handle, input.state);
    if (!pending) return this.#refuse('refused', 'state_mismatch');
    if (input.error !== undefined) return this.#refuse('refused', 'github_denied');
    if (input.code === undefined || !CODE.test(input.code)) {
      return this.#refuse('refused', 'bad_code');
    }

    // GitHub first, the tenant after: every callback with a valid state does the same outbound
    // work, so the time of the answer never shows whether a tenant exists (review, MEDIUM-1).
    let accountId: string;
    try {
      accountId = await this.#accountId(input.code, pending.verifier);
    } catch (error) {
      const cause = errorCode(error);
      return this.#refuse(cause === 'refused' ? 'refused' : 'unavailable', cause);
    }

    const tenant = await this.deps.db.system.getTenantBySlug(pending.tenantSlug);
    if (tenant?.status !== 'active') return this.#refuse('refused', 'tenant');
    const scope = this.deps.db.forTenant(parseTenantId(tenant.id));
    const found = await findSignInUser(scope, accountId);
    if (!found) return this.#refuse('refused', 'no_linked_user');

    const now = this.deps.now();
    if (input.previousSecret !== undefined) {
      const replaced = await this.deps.db.system.endWebSessionBySecret(
        hashSessionSecret(input.previousSecret),
        'replaced',
        now,
      );
      if (replaced) {
        await auditReplacedWebSession(
          this.deps.db.forTenant(replaced.tenantId),
          replaced.userId,
          now,
        );
      }
    }
    const started = await startWebSession(scope, {
      userId: found.user.id,
      identityId: found.identity.id,
      now,
      maxAgeMs: this.deps.settings.maxAgeMs,
    });
    this.deps.log.log('info', 'api.web_session_started', {
      tenantId: tenant.id,
      userId: found.user.id,
    });
    return {
      ok: true,
      secret: started.secret,
      maxAgeSeconds: Math.floor(this.deps.settings.maxAgeMs / 1000),
    };
  }

  /** Exchanges the code, reads the account ID, and always revokes the person's token. */
  async #accountId(code: string, verifier: string): Promise<string> {
    const token: RedactedSecret = await this.deps.provider.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: this.deps.settings.callbackUrl,
    });
    try {
      return await this.deps.provider.accountId(token);
    } finally {
      await this.deps.provider.revokeToken(token).catch((error: unknown) => {
        // GitHub App user tokens expire after 8 hours anyway; the failure is logged as a code.
        this.deps.log.log('warn', 'api.github_user_token_revoke_failed', {
          code: errorCode(error),
        });
      });
    }
  }

  #refuse(refusal: SignInRefusal, cause: string): { ok: false; refusal: SignInRefusal } {
    this.deps.log.log('info', 'api.signin_refused', { refusal, cause });
    return { ok: false, refusal };
  }
}

function errorCode(error: unknown): string {
  return error instanceof WebSignInError ? error.code : 'internal';
}
