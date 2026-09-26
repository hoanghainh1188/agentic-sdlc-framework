// GitHub App authentication (D-08 B05 AC1, design/ADR-M23 §2.2).
//
// - The App private key comes from the secret manager through `SecretReader` (D-03 §8.2), never
//   from an environment variable or a file. It is held as a `KeyObject` (never printed) and read
//   again after `keyCacheSeconds`, so a rotated key needs no restart.
// - App JWT: RS256, `iat` 60 s in the past (clock drift), `exp` 9 minutes ahead (GitHub allows 10).
// - Installation tokens are always limited to ONE repository and to the requested permissions.
//   The answer is checked: a token for more repositories or wider permissions is refused.
// - The adapter's own token (per repository, read + comment permissions) is cached until
//   `tokenRefreshMarginSeconds` before it expires. Tokens from `issueShortLivedToken` are never
//   cached: each call gives a new token, owned by the caller.
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

import {
  GIT_TOKEN_PERMISSIONS,
  GitHostError,
  type GitTokenPermission,
  type RepoRef,
  type TokenScope,
} from '@sdlc/contracts';

import type { GitHubHttp } from './http.js';
import { arr, checkRepo, id, obj, str, time } from './json.js';
import type { ResolvedOptions } from './options.js';

/** Permissions of the adapter's own token: read, and write comments (issues). */
export const ADAPTER_PERMISSIONS: TokenScope['permissions'] = {
  checks: 'read',
  contents: 'read',
  issues: 'write',
  pull_requests: 'read',
  statuses: 'read',
};

const ISSUER = /^[A-Za-z0-9._-]{1,64}$/;
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;

interface LoadedKey {
  readonly key: KeyObject;
  readonly issuer: string;
  readonly loadedAt: number;
}

export interface MintedToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly permissions: TokenScope['permissions'];
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

const base64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');
const repoKey = (ref: RepoRef): string => `${ref.owner}/${ref.name}`.toLowerCase();

/** Checks a requested scope: known permissions, `read` or `write`, at least one. */
export function checkScope(scope: TokenScope): TokenScope['permissions'] {
  const permissions: Partial<Record<GitTokenPermission, 'read' | 'write'>> = {};
  const entries = Object.entries(scope?.permissions ?? {});
  if (entries.length === 0) throw new GitHostError('invalid_input', { field: 'scope' });
  for (const [name, level] of entries) {
    if (!(GIT_TOKEN_PERMISSIONS as readonly string[]).includes(name)) {
      throw new GitHostError('invalid_input', { field: 'scope' });
    }
    if (level !== 'read' && level !== 'write') {
      throw new GitHostError('invalid_input', { field: 'scope' });
    }
    permissions[name as GitTokenPermission] = level;
  }
  return permissions;
}

export class AppAuth {
  readonly #options: ResolvedOptions;
  readonly #http: GitHubHttp;
  #key: LoadedKey | undefined;
  readonly #installations = new Map<string, string>();
  readonly #tokens = new Map<string, CachedToken>();
  readonly #pending = new Map<string, Promise<CachedToken>>();

  constructor(options: ResolvedOptions, http: GitHubHttp) {
    this.#options = options;
    this.#http = http;
  }

  /** Authorization header value for the adapter's own calls on one repository. */
  async repoAuth(ref: RepoRef): Promise<string> {
    const key = repoKey(checkRepo(ref));
    const now = this.#options.now().getTime();
    const cached = this.#tokens.get(key);
    if (cached && cached.expiresAtMs - this.#options.tokenRefreshMarginSeconds * 1000 > now) {
      return `Bearer ${cached.token}`;
    }
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = this.mint(ref, ADAPTER_PERMISSIONS)
        .then((t) => {
          const entry = { token: t.token, expiresAtMs: new Date(t.expiresAt).getTime() };
          this.#tokens.set(key, entry);
          return entry;
        })
        .finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    return `Bearer ${(await pending).token}`;
  }

  /** Runs `call` with the repository token; after a 401, drops the cached token and retries once. */
  async withRepoAuth<T>(ref: RepoRef, call: (auth: string) => Promise<T>): Promise<T> {
    try {
      return await call(await this.repoAuth(ref));
    } catch (error) {
      if (!(error instanceof GitHostError) || error.code !== 'auth_failed') throw error;
      this.#tokens.delete(repoKey(ref));
      return call(await this.repoAuth(ref));
    }
  }

  /** A new installation token for one repository with exactly `permissions` (or narrower). */
  async mint(ref: RepoRef, permissions: TokenScope['permissions']): Promise<MintedToken> {
    const repo = checkRepo(ref);
    const requested = checkScope({ permissions });
    const installation = await this.#installationId(repo);
    let res;
    try {
      res = await this.#http.json('POST', `app/installations/${installation}/access_tokens`, {
        auth: `Bearer ${await this.#jwt()}`,
        body: { repositories: [repo.name], permissions: requested },
      });
    } catch (error) {
      // The App may have been uninstalled or reinstalled (new installation ID), or the key
      // rotated: look both up again next time.
      if (error instanceof GitHostError && error.code === 'not_found') {
        this.#installations.delete(repoKey(repo));
        throw new GitHostError('app_not_installed', { repo: `${repo.owner}/${repo.name}` });
      }
      if (error instanceof GitHostError && error.code === 'auth_failed') this.#key = undefined;
      throw error;
    }
    const body = obj(res.body, 'token');
    const token = str(body.token, 'token.token');
    const expiresAt = time(body.expires_at, 'token.expires_at');
    const repos = arr(body.repositories, 'token.repositories');
    const only = repos.length === 1 ? obj(repos[0], 'token.repositories') : undefined;
    if (
      !only ||
      str(only.name, 'token.repositories.name').toLowerCase() !== repo.name.toLowerCase()
    ) {
      throw new GitHostError('invalid_response', { field: 'token.repositories' });
    }
    const granted = obj(body.permissions, 'token.permissions');
    const result: Partial<Record<GitTokenPermission, 'read' | 'write'>> = {};
    for (const [name, level] of Object.entries(granted)) {
      if (name === 'metadata' && level === 'read') continue;
      const want = requested[name as GitTokenPermission];
      if (
        !want ||
        (level !== 'read' && level !== 'write') ||
        (level === 'write' && want === 'read')
      ) {
        throw new GitHostError('invalid_response', { field: 'token.permissions' });
      }
      result[name as GitTokenPermission] = level;
    }
    this.#options.logger.log('info', 'git_host.token_issued', {
      repo: `${repo.owner}/${repo.name}`,
      expires_at: expiresAt,
      permissions: Object.entries(result)
        .map(([k, v]) => `${k}:${v}`)
        .sort()
        .join(','),
    });
    return { token, expiresAt, permissions: result };
  }

  async #installationId(ref: RepoRef): Promise<string> {
    const key = repoKey(ref);
    const known = this.#installations.get(key);
    if (known) return known;
    let res;
    try {
      res = await this.#http.json('GET', `repos/${ref.owner}/${ref.name}/installation`, {
        auth: `Bearer ${await this.#jwt()}`,
      });
    } catch (error) {
      if (error instanceof GitHostError && error.code === 'not_found') {
        throw new GitHostError('app_not_installed', { repo: `${ref.owner}/${ref.name}` });
      }
      if (error instanceof GitHostError && error.code === 'auth_failed') this.#key = undefined;
      throw error;
    }
    const installation = id(obj(res.body, 'installation').id, 'installation.id');
    this.#installations.set(key, installation);
    return installation;
  }

  async #jwt(): Promise<string> {
    const { key, issuer } = await this.#loadKey();
    const now = Math.floor(this.#options.now().getTime() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iat: now - JWT_BACKDATE_SECONDS,
        exp: now + JWT_LIFETIME_SECONDS,
        iss: issuer,
      }),
    );
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), key);
    return `${header}.${claims}.${base64url(signature)}`;
  }

  async #loadKey(): Promise<LoadedKey> {
    const now = this.#options.now().getTime();
    if (this.#key && now - this.#key.loadedAt < this.#options.keyCacheSeconds * 1000) {
      return this.#key;
    }
    const entry = await this.#options.secrets.read(this.#options.secretPath);
    const pem = entry.data.private_key;
    const issuerSecret = entry.data.client_id ?? entry.data.app_id;
    if (!pem || !issuerSecret) {
      throw new GitHostError('secret_invalid', { path: this.#options.secretPath });
    }
    const issuer = issuerSecret.reveal();
    let key: KeyObject;
    try {
      key = createPrivateKey(pem.reveal());
    } catch {
      throw new GitHostError('secret_invalid', { path: this.#options.secretPath });
    }
    if (key.asymmetricKeyType !== 'rsa' || !ISSUER.test(issuer)) {
      throw new GitHostError('secret_invalid', { path: this.#options.secretPath });
    }
    this.#key = { key, issuer, loadedAt: now };
    this.#options.logger.log('info', 'git_host.key_loaded', {
      path: this.#options.secretPath,
      version: entry.version,
    });
    return this.#key;
  }
}
