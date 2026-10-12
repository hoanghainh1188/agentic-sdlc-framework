// Signing in to the dashboard with a Git host account (task U05, design/ADR-M73 §2.2). The api
// uses this interface; `@sdlc/adapter-git-github` implements it with the platform's GitHub App
// (OAuth web flow with PKCE S256). The person's access token lives for one call: the api reads
// the numeric account ID, then revokes the token (QUESTIONS #388). It is never stored or logged.
import type { RedactedSecret } from './secrets.js';

export type WebSignInErrorCode =
  /** The Git host refused the code or the verifier (expired, reused, wrong browser). */
  | 'refused'
  /** The Git host could not be reached or answered with a server error. */
  | 'unavailable'
  /** The answer did not have the expected shape. */
  | 'bad_response';

/** Carries a code and the HTTP status only, never the Git host's text (it may hold a secret). */
export class WebSignInError extends Error {
  constructor(
    readonly code: WebSignInErrorCode,
    readonly status?: number,
  ) {
    super(`web sign-in: ${code}`);
    this.name = 'WebSignInError';
  }
}

export interface WebSignInProvider {
  /** The Git host page the browser is sent to. `codeChallenge` is the S256 challenge. */
  authorizeUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
  }): Promise<string>;
  /** Exchanges the code (with the PKCE verifier) for the person's short-lived access token. */
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<RedactedSecret>;
  /** The numeric account ID of the token's owner, as a decimal string. */
  accountId(token: RedactedSecret): Promise<string>;
  /** Revokes the token. A token already revoked or expired counts as revoked. */
  revokeToken(token: RedactedSecret): Promise<void>;
}
