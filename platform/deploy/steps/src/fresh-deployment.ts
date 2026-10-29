// The steps of platform/deploy/README.md "Fresh deployment (operator)" 3–7, shared by
// `pnpm server:setup` (a server, D-08 V16), `pnpm trial:up` (a developer machine, V02) and the live
// test `pnpm test:fresh-deploy`, so the three keep one sequence (R081, design/ADR-M98).
//
// Every secret goes to a child on stdin, never on a command line or in an environment variable:
// the root token, the admin token, the key shares, the database URL and the values of step 4. Every
// value is kept in the caller's `SecretBag`, so a failure shows the child's output redacted.
import path from 'node:path';

import type { Exec, ExecResult } from './exec.js';
import type { SecretBag } from './secrets.js';

/** README step 5, in its order: the credentials of every process. */
export const CREDENTIALS_COMMANDS = [
  'litellm-credentials',
  'api-credentials',
  'worker-credentials',
  'runner-credentials',
  'runner-evidence-credentials',
  'api-evidence-credentials',
  'worker-evidence-credentials',
  'worker-purge-credentials',
  'worker-anchor-credentials',
  'backup-credentials',
] as const;

/** README step 7: every profile of the server; `observability` and `knowledge` are optional. */
export const PROFILES = ['core', 'models', 'platform', 'sandbox'] as const;

/** README step 3: the stores that must run before OpenBao is configured. */
export const STORES = ['openbao', 'postgres', 'seaweedfs'] as const;

/** A step that failed: its name and the redacted end of its output. */
export class DeployStepError extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`deployment step ${step} failed`);
  }
}

export type OpenBaoState = 'uninitialised' | 'sealed' | 'unsealed';

/** The state `bootstrap.sh status` prints, or undefined. Pure. */
export function parseStatus(stdout: string): OpenBaoState | undefined {
  const m = /OpenBao is (uninitialised|sealed|unsealed)/.exec(stdout);
  return m?.[1] as OpenBaoState | undefined;
}

/** The admin token `configure --issue-admin-token` prints as its last line. Pure. */
export function parseAdminToken(stdout: string): string {
  const token = /^admin-token: (\S+)$/m.exec(stdout)?.[1] ?? '';
  if (token === '') throw new Error('configure printed no admin token');
  return token;
}

/** The key shares and the root token of `bao operator init -format=json`. Pure. */
export function parseInitJson(stdout: string): { shares: string[]; rootToken: string } {
  let doc: { unseal_keys_b64?: unknown; root_token?: unknown };
  try {
    doc = JSON.parse(stdout) as typeof doc;
  } catch {
    throw new Error('init output not understood');
  }
  const shares = Array.isArray(doc.unseal_keys_b64)
    ? doc.unseal_keys_b64.filter((s): s is string => typeof s === 'string' && s !== '')
    : [];
  const rootToken = typeof doc.root_token === 'string' ? doc.root_token : '';
  if (shares.length < 2 || rootToken === '') throw new Error('init output not understood');
  return { shares, rootToken };
}

/** A model provider of README step 4 (`litellm/config.ctmpl`). */
export type ProviderSecret =
  | { readonly provider: 'anthropic'; readonly apiKey: string }
  | { readonly provider: 'ollama'; readonly apiBase: string };

export interface DeploymentDeps {
  readonly repoRoot: string;
  readonly envFile: string;
  /** Every `docker compose` call passes `-p` with it (review V02): never the shell's project. */
  readonly composeProject: string;
  readonly exec: Exec;
  readonly bag: SecretBag;
  /** Extra environment of `bootstrap.sh` (the trial's `SDLC_OPENBAO_THROWAWAY`). */
  readonly bootstrapEnv?: Readonly<Record<string, string>>;
}

export class FreshDeployment {
  constructor(private readonly d: DeploymentDeps) {}

  get deployDir(): string {
    return path.join(this.d.repoRoot, 'platform/deploy');
  }

  /** The result, or a `DeployStepError` with the redacted end of the output. */
  ok(r: ExecResult, what: string): ExecResult {
    if (r.status !== 0) {
      const tail = this.d.bag
        .redact(`${r.stderr}\n${r.stdout}`)
        .trim()
        .split('\n')
        .slice(-30)
        .join('\n');
      throw new DeployStepError(what, tail);
    }
    return r;
  }

  run(
    cmd: string,
    args: readonly string[],
    input = '',
    env: Readonly<Record<string, string>> = {},
    detached = false,
  ): Promise<ExecResult> {
    return this.d.exec(cmd, args, {
      input,
      env: { SDLC_ENV_FILE: this.d.envFile, ...env },
      detached,
    });
  }

  compose(input: string, ...args: string[]): Promise<ExecResult> {
    return this.run(
      'docker',
      [
        'compose',
        '-p',
        this.d.composeProject,
        '-f',
        path.join(this.deployDir, 'docker-compose.yml'),
        '--env-file',
        this.d.envFile,
        ...args,
      ],
      input,
    );
  }

  bootstrap(args: readonly string[], input = '', detached = false): Promise<ExecResult> {
    return this.run(
      path.join(this.deployDir, 'openbao/bootstrap.sh'),
      args,
      input,
      this.d.bootstrapEnv,
      detached,
    );
  }

  /** README step 3: OpenBao, PostgreSQL and SeaweedFS only. Safe to run again. */
  async startStores(): Promise<void> {
    this.ok(
      await this.compose('', '--profile', 'core', 'up', '-d', '--wait', ...STORES),
      'openbao',
    );
  }

  async openbaoState(): Promise<OpenBaoState> {
    const r = this.ok(await this.bootstrap(['status']), 'openbao:status');
    const state = parseStatus(r.stdout);
    if (!state) throw new DeployStepError('openbao:status', 'unexpected status');
    return state;
  }

  /**
   * `bao operator init` with its output in this process's memory only (it never reaches the
   * terminal through a child). With one PGP public key per share (`-pgp-keys`, base64 of the
   * binary key), each share comes back encrypted for its holder: this process never sees a share
   * in clear (QUESTIONS #616 (c)). The public keys go into a temporary folder of the container on
   * stdin, and are removed at once.
   */
  async initOpenBao(opts: {
    readonly shares: number;
    readonly threshold: number;
    readonly pgpKeys?: readonly string[];
  }): Promise<{ shares: string[]; rootToken: string }> {
    const pgp = opts.pgpKeys ?? [];
    if (pgp.length > 0 && pgp.length !== opts.shares) {
      throw new DeployStepError('openbao:init', 'one PGP key per share');
    }
    const script =
      'set -e; d="$(mktemp -d)"; trap \'rm -rf "$d"\' EXIT; keys=""; i=0; ' +
      `while [ "$i" -lt ${pgp.length} ]; do IFS= read -r k; printf %s "$k" >"$d/k$i"; ` +
      'keys="${keys:+$keys,}$d/k$i"; i=$((i + 1)); done; ' +
      `bao operator init -key-shares=${opts.shares} -key-threshold=${opts.threshold} ` +
      '${keys:+-pgp-keys="$keys"} -format=json';
    const r = await this.compose(
      pgp.map((k) => `${k}\n`).join(''),
      'exec',
      '-T',
      'openbao',
      'sh',
      '-c',
      script,
    );
    // Kept before anything else reads the output, so a failure below never shows a share.
    for (const m of r.stdout.matchAll(/"([A-Za-z0-9+/=._-]{20,})"/g)) this.d.bag.keep(m[1]!);
    // Shares that came back are used even when the child then failed: OpenBao is initialised,
    // and without them it could only be wiped (review V16).
    try {
      const out = parseInitJson(r.stdout);
      this.d.bag.keep(out.rootToken);
      return out;
    } catch {
      this.ok(r, 'openbao:init');
      throw new DeployStepError('openbao:init', 'init output not understood');
    }
  }

  /** Unseals with key shares given on stdin (`bootstrap.sh unseal`). */
  async unseal(shares: readonly string[]): Promise<void> {
    for (const s of shares) this.d.bag.keep(s);
    this.ok(
      await this.bootstrap(['unseal'], shares.map((s) => `${s}\n`).join('')),
      'openbao:unseal',
    );
  }

  /** A new root token from key shares, in this process's memory only (T11 §5). */
  async rootTokenFromShares(shares: readonly string[]): Promise<string> {
    for (const s of shares) this.d.bag.keep(s);
    const r = this.ok(
      await this.compose(
        shares.map((s) => `${s}\n`).join(''),
        'exec',
        '-T',
        'openbao',
        'sh',
        '/openbao/bootstrap/root-token.sh',
      ),
      'openbao:root-token',
    );
    const token = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (token === '') throw new DeployStepError('openbao:root-token', 'no token');
    return this.d.bag.keep(token);
  }

  /**
   * README step 3: `configure` with the root token on stdin. It revokes the root token and gives
   * back one admin token (role `platform-admin`, at most 1 hour) for steps 4, 5 and 7.
   */
  async configure(rootToken: string): Promise<string> {
    const r = await this.bootstrap(['configure', '--issue-admin-token'], `${rootToken}\n`);
    // The admin token is kept before `ok` can show the output.
    const m = /^admin-token: (\S+)$/m.exec(r.stdout);
    if (m) this.d.bag.keep(m[1]!);
    // A failure after the admin token was made never leaves it valid (review V16).
    if (r.status !== 0 && m) await this.revoke(m[1]!);
    this.ok(r, 'openbao:configure');
    return parseAdminToken(r.stdout);
  }

  /** Revokes a token (`bao token revoke -self`); never fails. */
  async revoke(token: string): Promise<boolean> {
    const r = await this.compose(
      `${token}\n`,
      'exec',
      '-T',
      'openbao',
      'sh',
      '-c',
      'IFS= read -r t; BAO_TOKEN="$t" bao token revoke -self >/dev/null 2>&1',
    ).catch(() => ({ status: 1, stdout: '', stderr: '' }));
    return r.status === 0;
  }

  /** The seconds a token has left, or undefined when it is not valid or OpenBao cannot say. */
  async tokenTtl(token: string): Promise<number | undefined> {
    const state = await this.tokenState(token);
    return state.state === 'valid' ? state.ttl : undefined;
  }

  /**
   * Whether OpenBao still accepts a token: `invalid` only on a definite "permission denied" or
   * "bad token" answer; `unknown` when OpenBao is sealed or not reachable (review V16), so a
   * caller never takes an unanswered question for a revoked token.
   */
  async tokenState(
    token: string,
  ): Promise<{ state: 'valid'; ttl: number } | { state: 'invalid' | 'unknown' }> {
    const r = await this.compose(
      `${token}\n`,
      'exec',
      '-T',
      'openbao',
      'sh',
      '-c',
      'IFS= read -r t; BAO_TOKEN="$t" bao token lookup -self -field=ttl',
    ).catch(() => ({ status: 1, stdout: '', stderr: '' }));
    const ttl = Number(r.stdout.trim().replace(/s$/, ''));
    if (r.status === 0 && Number.isFinite(ttl)) return { state: 'valid', ttl };
    return /permission denied|bad token|invalid token/i.test(r.stderr)
      ? { state: 'invalid' }
      : { state: 'unknown' };
  }

  /**
   * Revokes every root token except `rootToken` itself, by accessor (accessors are not secrets):
   * the root token of a run that stopped while OpenBao was sealed, when nothing could revoke it
   * (review V16). Returns how many it revoked.
   */
  async revokeOtherRootTokens(rootToken: string): Promise<number> {
    const r = this.ok(
      await this.compose(
        `${rootToken}\n`,
        'exec',
        '-T',
        'openbao',
        'sh',
        '-c',
        'set -e; IFS= read -r t; export BAO_TOKEN="$t"; ' +
          'self="$(bao token lookup -self -field=accessor)"; n=0; ' +
          "for a in $(bao list -format=json auth/token/accessors | tr -d '[]\", '); do " +
          '[ "$a" = "$self" ] && continue; ' +
          'if bao token lookup -format=json -accessor "$a" 2>/dev/null | grep -q \'"root"\'; then ' +
          'bao token revoke -accessor "$a" >/dev/null; n=$((n + 1)); fi; done; echo "revoked=$n"',
      ),
      'openbao:revoke-old-root',
    );
    return Number(/revoked=(\d+)/.exec(r.stdout)?.[1] ?? 0);
  }

  /** An admin command in the OpenBao container: the token, then the values, on stdin. */
  async inOpenBao(token: string, script: string, input: string, what: string): Promise<void> {
    this.ok(
      await this.compose(
        `${token}\n${input}`,
        'exec',
        '-T',
        'openbao',
        'sh',
        '-c',
        `IFS= read -r t; export BAO_TOKEN="$t"; ${script}`,
      ),
      what,
    );
  }

  /** README step 4: the GitHub App's client ID and private key at `kv/shared/github-app`. */
  async storeGithubApp(token: string, clientId: string, privateKey: string): Promise<void> {
    this.d.bag.keep(privateKey);
    await this.inOpenBao(
      token,
      'IFS= read -r CLIENT_ID; bao kv put -mount=kv shared/github-app client_id="$CLIENT_ID" private_key=- >/dev/null',
      `${clientId}\n${privateKey.trim()}\n`,
      'secrets:github-app',
    );
  }

  /**
   * README step 4: the LiteLLM master and salt keys, made at random INSIDE the container, so they
   * never reach this process (T11 §5b, §5d).
   */
  async storeLitellmKeys(token: string): Promise<void> {
    const random = '"sk-$(od -An -N24 -tx1 /dev/urandom | tr -d \' \\n\')"';
    await this.inOpenBao(
      token,
      `set -e; m=${random}; s=${random}; [ "\${#m}" -eq 51 ] && [ "\${#s}" -eq 51 ]; ` +
        'printf %s "$m" | bao kv put -mount=kv cost-controller/litellm-master-key value=- >/dev/null; ' +
        'printf %s "$s" | bao kv put -mount=kv litellm/salt-key value=- >/dev/null',
      '',
      'secrets:litellm',
    );
  }

  /** README step 4: one model provider at `kv/litellm/providers/<provider>`. */
  async storeProvider(token: string, p: ProviderSecret): Promise<void> {
    if (p.provider === 'anthropic') {
      this.d.bag.keep(p.apiKey);
      await this.inOpenBao(
        token,
        'IFS= read -r p; printf %s "$p" | bao kv put -mount=kv litellm/providers/anthropic api_key=- >/dev/null',
        `${p.apiKey.trim()}\n`,
        'secrets:anthropic',
      );
    } else {
      await this.inOpenBao(
        token,
        'IFS= read -r u; bao kv put -mount=kv litellm/providers/ollama api_base="$u" >/dev/null',
        `${p.apiBase}\n`,
        'secrets:ollama',
      );
    }
  }

  /**
   * README steps 5 and 7: one `bootstrap.sh <x>-credentials` command, with the token and then
   * `extraInput` on stdin. `detached`: without a controlling terminal, for a command that would
   * otherwise ask for the token on `/dev/tty`.
   */
  async credentials(
    token: string,
    command: string,
    extraInput = '',
    detached = false,
  ): Promise<void> {
    this.ok(await this.bootstrap([command], `${token}\n${extraInput}`, detached), command);
  }

  /**
   * README step 6: the migrations, with the owner's URL on stdin (`migrate-cli --url-stdin`).
   * Running it when nothing is pending changes nothing. Returns the migrations it applied.
   */
  async migrate(ownerUrl: string): Promise<number> {
    this.d.bag.keep(ownerUrl);
    const r = this.ok(
      await this.run(
        'node',
        [
          path.join(this.d.repoRoot, 'platform/packages/core/dist/db/migrate-cli.js'),
          'latest',
          '--url-stdin',
        ],
        `${ownerUrl}\n`,
      ),
      'db:migrate',
    );
    return r.stdout.split('\n').filter((l) => /^Applied migration /.test(l)).length;
  }

  /** README step 7: `up.sh` with the profiles; it waits until every service is healthy. */
  async up(profiles: readonly string[]): Promise<void> {
    this.ok(
      await this.run(path.join(this.deployDir, 'scripts/up.sh'), [...profiles], '', {
        SDLC_WAIT_TIMEOUT: '900',
      }),
      'up.sh',
    );
  }
}
