// Dashboard sign-in with the platform's GitHub App (task U05, design/ADR-M73 §2.2): the OAuth web
// flow with PKCE (S256). GitHub still needs the App's client secret at the code exchange; it lives
// in OpenBao (`kv/api/github-oauth`, field `client_secret`), the client ID beside the App key
// (`kv/shared/github-app`, field `client_id`). Both are read again after `cacheSeconds`, so a
// rotated client secret needs no restart.
//
// - The person's token lives for one sign-in: the api reads the numeric account ID, then revokes
//   it (`DELETE /applications/{client_id}/token`, QUESTIONS #388). Never stored or logged.
// - Errors carry a code and an HTTP status only, never GitHub's text.
// - No retry: a code is used once; the person signs in again.
import {
  WebSignInError,
  type RedactedSecret,
  type SecretReader,
  type WebSignInProvider,
} from '@sdlc/contracts';

import { SecretString } from './secret-string.js';

export const DEFAULT_GITHUB_OAUTH_SECRET_PATH = 'api/github-oauth';

export interface GitHubSignInOptions {
  readonly secrets: SecretReader;
  /** KV path of the App entry with `client_id`. Default `shared/github-app`. */
  readonly appSecretPath?: string;
  /** KV path of the entry with `client_secret`. Default `api/github-oauth`. */
  readonly oauthSecretPath?: string;
  /** Browser-facing base URL. Default `https://github.com`. */
  readonly webUrl?: string;
  /** REST API base URL. Default `https://api.github.com`. */
  readonly apiUrl?: string;
  /** Allows `http://` URLs. Tests only (the in-process GitHub stub). */
  readonly allowPlaintext?: boolean;
  /** Default 15 000 ms. */
  readonly requestTimeoutMs?: number;
  /** Default 600 s. */
  readonly cacheSeconds?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

interface Credentials {
  readonly clientId: string;
  readonly clientSecret: RedactedSecret;
  readonly loadedAt: number;
}

const CLIENT_ID = /^[A-Za-z0-9.]{1,64}$/;
const CLIENT_SECRET = /^[A-Za-z0-9_.-]{20,255}$/;
const ACCESS_TOKEN = /^[A-Za-z0-9_.-]{20,255}$/;
const USER_AGENT = 'agentic-sdlc-framework-api';
const API_VERSION = '2022-11-28';

function baseUrl(value: string, allowPlaintext: boolean, field: string): URL {
  const url = new URL(value.endsWith('/') ? value : `${value}/`);
  if (url.protocol !== 'https:' && !(allowPlaintext && url.protocol === 'http:')) {
    throw new TypeError(`${field} must use https://`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(`${field} must be a plain base URL`);
  }
  return url;
}

export class GitHubSignIn implements WebSignInProvider {
  readonly #secrets: SecretReader;
  readonly #appPath: string;
  readonly #oauthPath: string;
  readonly #web: URL;
  readonly #api: URL;
  readonly #timeoutMs: number;
  readonly #cacheMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #credentials: Credentials | undefined;

  constructor(options: GitHubSignInOptions) {
    const plain = options.allowPlaintext === true;
    this.#secrets = options.secrets;
    this.#appPath = options.appSecretPath ?? 'shared/github-app';
    this.#oauthPath = options.oauthSecretPath ?? DEFAULT_GITHUB_OAUTH_SECRET_PATH;
    this.#web = baseUrl(options.webUrl ?? 'https://github.com', plain, 'webUrl');
    this.#api = baseUrl(options.apiUrl ?? 'https://api.github.com', plain, 'apiUrl');
    this.#timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#cacheMs = (options.cacheSeconds ?? 600) * 1000;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async authorizeUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
  }): Promise<string> {
    const { clientId } = await this.#loadCredentials();
    const url = new URL('login/oauth/authorize', this.#web);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // No account picker for a new account: the person must already be linked.
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  }

  async exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<RedactedSecret> {
    const { clientId, clientSecret } = await this.#loadCredentials();
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret.reveal(),
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
    const response = await this.#call(new URL('login/oauth/access_token', this.#web), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
    });
    // GitHub answers 200 with `error` in the body for a bad code or verifier.
    const json = await this.#json(response);
    const token = json.access_token;
    if (response.status !== 200 || typeof json.error === 'string') {
      throw new WebSignInError('refused', response.status);
    }
    if (typeof token !== 'string' || !ACCESS_TOKEN.test(token)) {
      // A token in an unexpected shape is still a token: revoke it, best effort, before refusing
      // (security review of U05, LOW-2).
      if (typeof token === 'string' && token.length > 0 && token.length <= 1024) {
        await this.revokeToken(new SecretString(token)).catch(() => undefined);
      }
      throw new WebSignInError('bad_response', response.status);
    }
    return new SecretString(token);
  }

  async accountId(token: RedactedSecret): Promise<string> {
    const response = await this.#call(new URL('user', this.#api), {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token.reveal()}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
      },
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new WebSignInError('refused', response.status);
    }
    const json = await this.#json(response);
    if (response.status !== 200) throw new WebSignInError('unavailable', response.status);
    const id = json.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new WebSignInError('bad_response', response.status);
    }
    return String(id);
  }

  async revokeToken(token: RedactedSecret): Promise<void> {
    const { clientId, clientSecret } = await this.#loadCredentials();
    const basic = Buffer.from(`${clientId}:${clientSecret.reveal()}`, 'utf8').toString('base64');
    const response = await this.#call(
      new URL(`applications/${encodeURIComponent(clientId)}/token`, this.#api),
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({ access_token: token.reveal() }),
      },
    );
    await response.body?.cancel();
    // 204 revoked; 404 or 422: unknown, already revoked or expired.
    if (response.status === 204 || response.status === 404 || response.status === 422) return;
    throw new WebSignInError(response.status >= 500 ? 'unavailable' : 'refused', response.status);
  }

  async #loadCredentials(): Promise<Credentials> {
    const now = this.#now().getTime();
    if (this.#credentials && now - this.#credentials.loadedAt < this.#cacheMs) {
      return this.#credentials;
    }
    let app;
    let oauth;
    try {
      [app, oauth] = await Promise.all([
        this.#secrets.read(this.#appPath),
        this.#secrets.read(this.#oauthPath),
      ]);
    } catch {
      throw new WebSignInError('unavailable');
    }
    const clientId = app.data.client_id?.reveal();
    const clientSecret = oauth.data.client_secret?.reveal();
    if (
      clientId === undefined ||
      !CLIENT_ID.test(clientId) ||
      clientSecret === undefined ||
      !CLIENT_SECRET.test(clientSecret)
    ) {
      throw new WebSignInError('unavailable');
    }
    this.#credentials = { clientId, clientSecret: new SecretString(clientSecret), loadedAt: now };
    return this.#credentials;
  }

  async #call(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new WebSignInError('unavailable');
    }
  }

  async #json(response: Response): Promise<Record<string, unknown>> {
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new WebSignInError('unavailable', response.status);
    }
    try {
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new WebSignInError('bad_response', response.status);
      }
      return body as Record<string, unknown>;
    } catch (error) {
      if (error instanceof WebSignInError) throw error;
      throw new WebSignInError('bad_response', response.status);
    }
  }
}
