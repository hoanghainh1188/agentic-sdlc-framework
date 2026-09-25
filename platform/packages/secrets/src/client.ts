// OpenBao client for the platform processes (D-08 A04, design/ADR-M21).
//
// - AppRole login with the role ID and secret ID files; the secret ID file is read again at
//   every login, so a rotated secret ID needs no restart.
// - The token is renewed at 2/3 of its TTL. The TTLs come from OpenBao (bootstrap.conf); none is
//   hard-coded here. When renewal no longer extends the token (maximum TTL near), the client logs
//   in again and revokes the old token.
// - A 503 is explained with `sys/seal-status`: "not initialised" or "sealed", instead of a bare
//   503 (QUESTIONS #2). A 403 is checked with `lookup-self`: an expired or revoked token leads to
//   one new login and one retry; a policy refusal is reported as such, without a login loop.
import type { SecretReader } from '@sdlc/contracts';
import { t } from '@sdlc/messages';

import { SecretsError } from './errors.js';
import { KvReader } from './kv.js';
import { silentLogger, type SecretsLogger } from './logger.js';
import {
  ENV,
  optionsFromEnv,
  readCredentialFile,
  resolveOptions,
  RUN_CONTRACT_KEY,
  type OpenBaoClientOptions,
  type ResolvedOptions,
} from './options.js';
import { TransitKey } from './transit.js';
import { Transport, type HttpResponse } from './transport.js';

export interface CallRequest {
  /** Short name of the operation, used in error messages (for example `read`, `sign`). */
  readonly operation: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  /** Status codes the caller handles itself, besides 2xx. */
  readonly accept?: readonly number[];
}

export type Caller = (request: CallRequest) => Promise<HttpResponse>;

export interface SealStatus {
  readonly initialized: boolean;
  readonly sealed: boolean;
}

interface TokenState {
  readonly value: string;
  readonly expiresAt: number;
  readonly loginTtlSeconds: number;
  readonly renewable: boolean;
}

/** Renew or log in again at this share of the token lifetime. */
const REFRESH_AT = 2 / 3;
/** A token closer than this to expiry is not used; the client logs in first. */
const EXPIRY_MARGIN_MS = 5_000;
const RETRY_MS = 30_000;

export class OpenBaoClient {
  readonly #options: ResolvedOptions;
  readonly #transport: Transport;
  readonly #logger: SecretsLogger;
  #token: TokenState | undefined;
  #loginInFlight: Promise<string> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: OpenBaoClientOptions) {
    this.#options = resolveOptions(options);
    this.#transport = new Transport(this.#options);
    this.#logger = options.logger ?? silentLogger;
    this.#warnIfPlaintext();
  }

  /** Reads the settings from `SDLC_OPENBAO_*` environment variables. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, logger?: SecretsLogger): OpenBaoClient {
    return new OpenBaoClient({ ...optionsFromEnv(env), ...(logger ? { logger } : {}) });
  }

  get address(): string {
    return this.#transport.address;
  }

  /** Seal status; needs no token. */
  async sealStatus(): Promise<SealStatus> {
    const res = await this.#transport.request('GET', 'sys/seal-status');
    const body = res.body as Partial<SealStatus> | undefined;
    if (
      res.status !== 200 ||
      typeof body?.initialized !== 'boolean' ||
      typeof body.sealed !== 'boolean'
    ) {
      throw new SecretsError('secrets.openbao.invalid_response', { operation: 'sys/seal-status' });
    }
    return { initialized: body.initialized, sealed: body.sealed };
  }

  /** Fails fast at start-up: throws when OpenBao is unreachable, not initialised or sealed. */
  async assertReady(): Promise<void> {
    this.#throwIfNotReady(await this.sealStatus());
  }

  /** Logs in now (normally the first request does it). */
  async login(): Promise<void> {
    await this.#loginOnce();
  }

  /** Renews the token now; logs in again when it cannot be renewed. */
  async renewNow(): Promise<void> {
    const token = this.#token;
    if (!token || !token.renewable) {
      await this.#relogin();
      return;
    }
    const res = await this.#transport.request('POST', 'auth/token/renew-self', {
      token: token.value,
      body: { increment: `${token.loginTtlSeconds}s` },
    });
    if (res.status === 403) {
      this.#dropToken(token.value);
      await this.#loginOnce();
      return;
    }
    if (res.status === 503) await this.#explain503();
    if (res.status !== 200) {
      throw new SecretsError('secrets.openbao.unexpected_status', {
        status: res.status,
        operation: 'renew',
      });
    }
    const auth = parseAuth(res.body, 'renew');
    this.#setToken({ ...token, expiresAt: Date.now() + auth.ttlSeconds * 1000 });
    this.#logger.log('info', 'openbao.token_renewed', { ttl_seconds: auth.ttlSeconds });
    // Less than asked for: the maximum TTL is near, so the next step is a new login.
    this.#schedule(auth.ttlSeconds, auth.ttlSeconds < token.loginTtlSeconds ? 'login' : 'renew');
  }

  /** Remaining lifetime and renewability of the current token (no token value). */
  tokenInfo(): { expiresAt: number; renewable: boolean } | undefined {
    const token = this.#token;
    return token && { expiresAt: token.expiresAt, renewable: token.renewable };
  }

  /** Reads KV v2 secrets under the process's own paths. */
  kv(): SecretReader {
    return new KvReader(this.#options.mounts.kv, (request) => this.#call(request));
  }

  /** Signs and verifies with a Transit key (default: the Run Contract key). */
  transit(key: string = RUN_CONTRACT_KEY): TransitKey {
    return new TransitKey(this.#options.mounts.transit, key, (request) => this.#call(request));
  }

  /** Stops renewal and revokes the token. The client cannot be used afterwards. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    // A login in flight finishes first; seeing `closed`, it revokes its own new token.
    await this.#loginInFlight?.catch(() => undefined);
    const token = this.#token;
    this.#token = undefined;
    if (token) await this.#revoke(token.value);
    this.#transport.close();
  }

  async #call(request: CallRequest, retried = false): Promise<HttpResponse> {
    const token = await this.#currentToken();
    const res = await this.#transport.request(request.method, request.path, {
      token,
      body: request.body,
    });
    if ((res.status >= 200 && res.status < 300) || request.accept?.includes(res.status)) {
      return res;
    }
    if (res.status === 503) await this.#explain503();
    if (res.status === 403) {
      if (!retried && !(await this.#tokenIsValid(token))) {
        this.#dropToken(token);
        this.#logger.log('warn', 'openbao.token_expired', { operation: request.operation });
        return this.#call(request, true);
      }
      throw new SecretsError('secrets.permission_denied', {
        operation: request.operation,
        path: request.path.split('?')[0] ?? '',
      });
    }
    throw new SecretsError('secrets.openbao.unexpected_status', {
      status: res.status,
      operation: request.operation,
    });
  }

  async #currentToken(): Promise<string> {
    if (this.#closed) throw new SecretsError('secrets.client_closed');
    const token = this.#token;
    if (token && Date.now() < token.expiresAt - EXPIRY_MARGIN_MS) return token.value;
    return this.#loginOnce();
  }

  /** One login at a time: concurrent callers share it. */
  #loginOnce(): Promise<string> {
    this.#loginInFlight ??= this.#doLogin().finally(() => {
      this.#loginInFlight = undefined;
    });
    return this.#loginInFlight;
  }

  async #doLogin(): Promise<string> {
    if (this.#closed) throw new SecretsError('secrets.client_closed');
    const roleId = readCredentialFile(this.#options.roleIdFile, ENV.roleIdFile);
    const secretId = readCredentialFile(this.#options.secretIdFile, ENV.secretIdFile);
    const res = await this.#transport.request(
      'POST',
      `auth/${this.#options.mounts.approle}/login`,
      {
        body: { role_id: roleId, secret_id: secretId },
      },
    );
    if (res.status === 503) await this.#explain503();
    if (res.status !== 200) {
      throw new SecretsError('secrets.login_failed', {
        status: res.status,
        file: this.#options.secretIdFile,
      });
    }
    const auth = parseAuth(res.body, 'login');
    if (this.#closed) {
      // close() ran while this login was in flight: do not keep a token nobody will revoke.
      await this.#revoke(auth.token);
      throw new SecretsError('secrets.client_closed');
    }
    this.#setToken({
      value: auth.token,
      expiresAt: Date.now() + auth.ttlSeconds * 1000,
      loginTtlSeconds: auth.ttlSeconds,
      renewable: auth.renewable,
    });
    this.#logger.log('info', 'openbao.login', {
      ttl_seconds: auth.ttlSeconds,
      renewable: auth.renewable,
    });
    this.#warnIfPlaintext();
    this.#schedule(auth.ttlSeconds, auth.renewable ? 'renew' : 'login');
    return auth.token;
  }

  /** Scheduled new login: log in, then revoke the old token. */
  async #relogin(): Promise<void> {
    const old = this.#token;
    this.#token = undefined;
    await this.#loginOnce();
    if (old) await this.#revoke(old.value);
  }

  #schedule(ttlSeconds: number, next: 'renew' | 'login'): void {
    this.#scheduleIn(Math.floor(ttlSeconds * 1000 * REFRESH_AT), next);
  }

  #scheduleIn(delayMs: number, next: 'renew' | 'login'): void {
    clearTimeout(this.#timer);
    if (this.#closed) return;
    this.#timer = setTimeout(() => void this.#refresh(next), delayMs);
    this.#timer.unref();
  }

  /** Timer callback: never throws. On failure it retries while the token is still valid. */
  async #refresh(next: 'renew' | 'login'): Promise<void> {
    try {
      await (next === 'renew' ? this.renewNow() : this.#relogin());
    } catch (error) {
      if (this.#closed) return; // close() ran meanwhile: nothing to renew
      const key = error instanceof SecretsError ? error.key : 'unknown';
      this.#logger.log('warn', 'openbao.renew_failed', { step: next, error: key });
      const remaining = (this.#token?.expiresAt ?? 0) - Date.now();
      if (remaining > EXPIRY_MARGIN_MS) {
        this.#scheduleIn(Math.min(RETRY_MS, Math.floor(remaining / 2)), next);
      } else {
        this.#token = undefined; // the next request logs in
      }
    }
  }

  async #tokenIsValid(token: string): Promise<boolean> {
    const res = await this.#transport.request('GET', 'auth/token/lookup-self', { token });
    if (res.status === 503) await this.#explain503();
    return res.status === 200;
  }

  async #revoke(token: string): Promise<void> {
    try {
      const res = await this.#transport.request('POST', 'auth/token/revoke-self', { token });
      if (res.status !== 204 && res.status !== 200 && res.status !== 403) {
        this.#logger.log('warn', 'openbao.revoke_failed', { status: res.status });
      }
    } catch (error) {
      const key = error instanceof SecretsError ? error.key : 'unknown';
      this.#logger.log('warn', 'openbao.revoke_failed', { error: key });
    }
  }

  /** Every 503 is explained: not initialised, sealed, or an unexpected status. Always throws. */
  async #explain503(): Promise<never> {
    this.#throwIfNotReady(await this.sealStatus());
    throw new SecretsError('secrets.openbao.unexpected_status', {
      status: 503,
      operation: 'request',
    });
  }

  #throwIfNotReady(status: SealStatus): void {
    if (!status.initialized) {
      throw new SecretsError('secrets.openbao.not_initialised', { address: this.address });
    }
    if (status.sealed) throw new SecretsError('secrets.openbao.sealed', { address: this.address });
  }

  #setToken(token: TokenState): void {
    this.#token = token;
  }

  #dropToken(value: string): void {
    if (this.#token?.value === value) this.#token = undefined;
  }

  #warnIfPlaintext(): void {
    if (!this.#options.plaintext) return;
    const params = { address: this.address, name: ENV.allowPlaintext };
    this.#logger.log('warn', 'openbao.plaintext', {
      ...params,
      message: t('secrets.warning.plaintext', params),
    });
  }
}

interface ParsedAuth {
  readonly token: string;
  readonly ttlSeconds: number;
  readonly renewable: boolean;
}

function parseAuth(body: unknown, operation: string): ParsedAuth {
  const auth = (body as { auth?: Record<string, unknown> } | undefined)?.auth;
  const token = auth?.['client_token'];
  const ttl = auth?.['lease_duration'];
  const renewable = auth?.['renewable'];
  if (typeof token !== 'string' || !token || typeof ttl !== 'number' || ttl <= 0) {
    throw new SecretsError('secrets.openbao.invalid_response', { operation });
  }
  return { token, ttlSeconds: ttl, renewable: renewable === true };
}
