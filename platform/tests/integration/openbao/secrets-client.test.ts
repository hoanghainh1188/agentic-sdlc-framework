// D-08 task A04: live test of the OpenBao client (@sdlc/secrets) against OpenBao in Compose (AC2),
// design/ADR-M21. Needs Docker. Skipped unless SDLC_OPENBAO_TEST=1. Run with: pnpm test:openbao
//
// Uses its own throw-away Compose project (own name, ports, subnet, random env file) that starts
// only the openbao service; everything is removed afterwards. The client runs in a node container
// on the Compose network (inside the bound CIDR), like a platform process (secrets-driver.mjs).
// Key shares, tokens and secret IDs are THROW-AWAY TEST KEYS: kept in variables of this process,
// never printed, never part of an assertion message (errors go through redact()).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir, root } from '../../deploy/compose';
import { containerIp, hostPortBindings, isolateEnv, networkGateways } from '../throwaway-compose';

const enabled = process.env.SDLC_OPENBAO_TEST === '1';
const PORT_OFFSET = 22000;
const SETUP_TIMEOUT_MS = 5 * 60 * 1000;
const TEST_TIMEOUT_MS = 2 * 60 * 1000;
// Same pinned image as the OpenHands spike (platform/spikes/openhands).
const NODE_IMAGE =
  'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
const DRIVER = '/repo/platform/tests/integration/openbao/secrets-driver.mjs';
const PAYLOAD = '{"run_id":"RUN-IT-1","tenant_id":"t-it"}';

type Role = 'worker' | 'runner' | 'api';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface StepResult {
  step: string;
  ok: boolean;
  value?: unknown;
  key?: string;
  message?: string;
}

interface DriverOutput {
  results: StepResult[];
  events: { level: string; event: string; fields: Record<string, unknown> }[];
}

type Step = { name: string } & Record<string, unknown>;

describe.skipIf(!enabled)('OpenBao client (live)', { timeout: TEST_TIMEOUT_MS }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-secrets-it-'));
  const envFile = path.join(tmp, 'it.env');
  const project = `sdlcsec${process.pid}`;
  const network = `${project}-net`;
  const subnet = `172.30.${225 + (process.pid % 25)}.0/24`;
  // A gateway that is not .1, to check the exclusion with another address (QUESTIONS #37).
  const gateway = subnet.replace(/0\/24$/, '254');
  const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');

  // Throw-away secrets, kept in memory only.
  const secrets: string[] = [];
  const outputs: string[] = [];
  let shares: string[] = [];
  let rootToken = '';
  const roleIds = new Map<Role, string>();
  const secretIds = new Map<Role, string>();
  const values = {
    workerDb: `it-worker-db-${process.pid}`,
    githubApp: `it-github-app-${process.pid}`,
    masterKey: `it-master-key-${process.pid}`,
  };
  let signature = '';

  const keep = (value: string): string => {
    if (value) secrets.push(value);
    return value;
  };
  const redact = (text: string): string =>
    secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);

  const run = (cmd: string, args: string[], input = '', env: NodeJS.ProcessEnv = {}): Result => {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      input,
      env: { ...process.env, SDLC_ENV_FILE: envFile, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const ok = (r: Result, what: string): Result => {
    if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${redact(r.stderr)}`);
    return r;
  };
  const compose = (input: string, ...args: string[]): Result =>
    run(
      'docker',
      ['compose', '-f', path.join(deployDir, 'docker-compose.yml'), '--env-file', envFile, ...args],
      input,
    );
  const bootstrapCmd = (args: string[], input = ''): Result =>
    run(bootstrap, args, input, { SDLC_OPENBAO_TEST: '1' });
  // The admin commands run with the throw-away root token inside the openbao container.
  const admin = (script: string): string =>
    ok(
      compose(
        `${rootToken}\n`,
        'exec',
        '-T',
        'openbao',
        'sh',
        '-c',
        `IFS= read -r t; export BAO_TOKEN="$t"; ${script}`,
      ),
      'admin command',
    ).stdout.trim();
  const openbaoContainer = (): string => compose('', 'ps', '-q', 'openbao').stdout.trim();

  /**
   * Runs the client in a node container on the Compose network, or with `fromHost` in the Docker
   * host network namespace against the container IP (source address: the gateway).
   */
  const driver = (
    role: Role | undefined,
    steps: Step[],
    extra: Record<string, string> = {},
    fromHost = false,
  ): DriverOutput => {
    const input = JSON.stringify({
      roleId: role ? roleIds.get(role) : undefined,
      secretId: role ? secretIds.get(role) : undefined,
      ...extra,
      steps,
    });
    const r = run(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        fromHost ? 'host' : network,
        '--user',
        'node',
        '--tmpfs',
        '/run/sdlc:uid=1000,gid=1000,mode=0700',
        '-v',
        `${root}:/repo:ro`,
        '-e',
        `SDLC_OPENBAO_ADDR=http://${fromHost ? containerIp(openbaoContainer(), network) : 'openbao'}:8200`,
        '-e',
        'SECRETS_DIST=/repo/platform/packages/secrets/dist/index.js',
        NODE_IMAGE,
        'node',
        DRIVER,
      ],
      input,
    );
    outputs.push(r.stdout, r.stderr);
    ok(r, 'driver');
    return JSON.parse(r.stdout) as DriverOutput;
  };
  const results = (
    role: Role | undefined,
    steps: Step[],
    extra?: Record<string, string>,
  ): Map<string, StepResult> =>
    new Map(driver(role, steps, extra).results.map((r, i) => [`${i}:${r.step}`, r]));
  const health = (): string =>
    compose('', 'ps', '--format', '{{.Health}}', 'openbao').stdout.trim();

  beforeAll(() => {
    // The driver loads the built package (dist): build it and its references.
    ok(run(path.join(root, 'node_modules/.bin/tsc'), ['-b', 'platform/packages/secrets']), 'build');
    ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
    const text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
      project,
      subnet,
      gateway,
      portOffset: PORT_OFFSET,
    });
    fs.writeFileSync(envFile, text, { mode: 0o600 });
    ok(compose('', '--profile', 'core', 'up', '-d', '--wait', 'openbao'), 'compose up openbao');
    ok(run('docker', ['pull', '-q', NODE_IMAGE]), 'pull node image');
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    compose('', '--profile', 'core', 'down', '--volumes', '--remove-orphans');
    fs.rmSync(tmp, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  describe('QUESTIONS #2: clear errors while OpenBao is "healthy" but not usable', () => {
    it('not initialised: healthy in Compose, the client says "not initialised"', () => {
      expect(health()).toBe('healthy');
      const r = results('worker', [{ name: 'ready' }, { name: 'login' }]);
      expect([...r.values()].map((s) => s.key)).toEqual([
        'secrets.openbao.not_initialised',
        'secrets.openbao.not_initialised',
      ]);
      expect(r.get('0:ready')?.message).toMatch(/is not initialised/);
    });

    it('initialised but sealed: healthy in Compose, the client says "sealed"', () => {
      const r = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
      shares = [...r.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(r.stdout)?.[1] ?? '');
      expect(health()).toBe('healthy');
      const s = results('worker', [{ name: 'ready' }, { name: 'login' }]);
      expect([...s.values()].map((x) => x.key)).toEqual([
        'secrets.openbao.sealed',
        'secrets.openbao.sealed',
      ]);
    });
  });

  describe('AC1 and AC2: login, KV v2, Transit, renewal against the real server', () => {
    it('prepares: unseal, configure, AppRole credentials, throw-away secrets', () => {
      ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
      ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');
      for (const role of ['worker', 'runner', 'api'] as const) {
        roleIds.set(role, admin(`bao read -field=role_id auth/approle/role/${role}/role-id`));
        secretIds.set(
          role,
          keep(admin(`bao write -f -field=secret_id auth/approle/role/${role}/secret-id`)),
        );
      }
      for (const v of Object.values(values)) keep(v);
      admin(
        `bao kv put -mount=kv worker/db value=${values.workerDb} >/dev/null && ` +
          `bao kv put -mount=kv shared/github-app value=${values.githubApp} >/dev/null && ` +
          `bao kv put -mount=kv cost-controller/litellm-master-key value=${values.masterKey} >/dev/null && ` +
          'bao kv put -mount=kv api/x value=1 >/dev/null',
      );
    });

    it('worker: reads its own secret, is refused others, signs, verifies, renews', () => {
      const r = results('worker', [
        { name: 'ready' },
        { name: 'read', path: 'worker/db', expect: values.workerDb },
        { name: 'read', path: 'api/x' },
        { name: 'read', path: 'worker/missing' },
        { name: 'sign', payload: PAYLOAD },
        { name: 'publicKeyLength', version: 1 },
        { name: 'renew' },
      ]);
      expect(r.get('0:ready')?.ok).toBe(true);
      expect(r.get('1:read')?.value).toEqual({ version: 1, matches: true });
      expect(r.get('2:read')?.key).toBe('secrets.permission_denied');
      expect(r.get('3:read')?.key).toBe('secrets.not_found');
      const signed = r.get('4:sign')?.value as { signature: string; keyVersion: number };
      expect(signed.keyVersion).toBe(1);
      expect(signed.signature).toMatch(/^vault:v1:/);
      signature = signed.signature;
      expect(r.get('5:publicKeyLength')?.value).toBe(32);
      expect(r.get('6:renew')?.value).toEqual({ renewed: true, renewable: true });
    });

    it('runner: verifies the worker signature (Transit and locally), cannot sign or read the master key', () => {
      const r = results('runner', [
        { name: 'verify', payload: PAYLOAD, signature },
        { name: 'verifyLocally', payload: PAYLOAD, signature },
        { name: 'verify', payload: `${PAYLOAD} `, signature },
        { name: 'verifyLocally', payload: `${PAYLOAD} `, signature },
        { name: 'sign', payload: PAYLOAD },
        { name: 'read', path: 'cost-controller/litellm-master-key' },
        { name: 'read', path: 'shared/github-app', expect: values.githubApp },
        { name: 'wrap', value: values.githubApp, ttlSeconds: 60 },
      ]);
      expect([...r.values()].slice(0, 4).map((s) => s.value)).toEqual([true, true, false, false]);
      expect(r.get('4:sign')?.key).toBe('secrets.permission_denied');
      expect(r.get('5:read')?.key).toBe('secrets.permission_denied');
      // QUESTIONS #44: the runner no longer reads the GitHub App key.
      expect(r.get('6:read')?.key).toBe('secrets.permission_denied');
      // OpenBao's built-in `default` policy lets every token wrap data it already holds. Harmless:
      // wrapping grants no access; it only packages the caller's own data (ADR-M25 §2.11).
      expect(r.get('7:wrap')?.value).toBe('wrapped');
    });

    it('worker wraps a token; the wrapping token opens exactly once (QUESTIONS #44)', () => {
      const r = results('worker', [
        { name: 'wrap', value: values.githubApp, ttlSeconds: 60 },
        { name: 'unwrap', expect: values.githubApp },
        { name: 'unwrap', expect: values.githubApp },
      ]);
      expect(r.get('0:wrap')?.value).toBe('wrapped');
      expect(r.get('1:unwrap')?.value).toEqual({ matches: true });
      expect(r.get('2:unwrap')?.key).toBe('secrets.wrapping.invalid_token');
    });

    it('api: cannot sign Run Contracts', () => {
      expect(results('api', [{ name: 'sign', payload: PAYLOAD }]).get('0:sign')?.key).toBe(
        'secrets.permission_denied',
      );
    });

    it('a revoked token leads to one new login, and the request succeeds', () => {
      const out = driver(
        'worker',
        [
          { name: 'read', path: 'worker/db', expect: values.workerDb },
          { name: 'revokeAllTokens' },
          { name: 'read', path: 'worker/db', expect: values.workerDb },
          { name: 'loginCount' },
        ],
        { adminToken: rootToken },
      );
      expect(out.results.map((r) => r.value)).toEqual([
        { version: 1, matches: true },
        204,
        { version: 1, matches: true },
        2,
      ]);
      expect(out.events.map((e) => e.event)).toContain('openbao.token_expired');
    });

    it('a wrong secret ID fails with login_failed', () => {
      const r = driver(undefined, [{ name: 'login' }], {
        roleId: roleIds.get('worker')!,
        secretId: 'wrong',
      });
      expect(r.results[0]).toMatchObject({ ok: false, key: 'secrets.login_failed' });
    });

    it('A11 (QUESTIONS #27): OpenBao publishes no port on the host', () => {
      const bindings = hostPortBindings(openbaoContainer());
      expect(Object.keys(bindings)).toContain('8200/tcp');
      for (const [port, binding] of Object.entries(bindings)) expect(binding, port).toBeNull();
    });

    it('A11 (QUESTIONS #37): the network gateway is SDLC_NETWORK_GATEWAY, not .1', () => {
      expect(networkGateways(network)).toEqual([gateway]);
    });

    it('A11 (QUESTIONS #37): an AppRole login from the Docker host is refused', () => {
      // On Linux every host process reaches the container IP from the gateway. The gateway is
      // left out of the bound CIDRs, so the login is refused (on Docker Desktop: from the VM).
      const r = driver('worker', [{ name: 'login' }], {}, true);
      expect(r.results[0]).toMatchObject({ ok: false, key: 'secrets.login_failed' });
      const audit = admin(
        'grep "approle/login" /openbao/logs/audit.log | tail -1 | grep -o \'"remote_address":"[^"]*"\'',
      );
      expect(audit).toBe(`"remote_address":"${gateway}"`);
    });

    it('A11: the same credentials still log in from the Compose network', () => {
      const r = driver('worker', [{ name: 'login' }]);
      expect(r.results[0]?.ok).toBe(true);
    });
  });

  describe('after a restart', () => {
    it('OpenBao is sealed again; healthy in Compose; the client says "sealed"', () => {
      ok(compose('', '--profile', 'core', 'restart', 'openbao'), 'restart');
      ok(compose('', '--profile', 'core', 'up', '-d', '--wait', 'openbao'), 'wait healthy');
      expect(health()).toBe('healthy');
      const r = results('worker', [{ name: 'read', path: 'worker/db' }]);
      expect(r.get('0:read')?.key).toBe('secrets.openbao.sealed');
    });
  });

  describe('AC3: no secret in any output', () => {
    it('no key share, root token, secret ID or secret value in the driver output or logs', () => {
      expect(secrets.length).toBeGreaterThan(8);
      const all = outputs.join('\n');
      expect(secrets.filter((s) => all.includes(s)).length).toBe(0); // never print the values
    });
  });
});
