// D-08 task B03: live test of the sdlc-api container (design/ADR-M26 section 2.6). Needs Docker.
// Skipped unless SDLC_API_TEST=1. Run with: pnpm test:api
//
// Own throw-away Compose project (own name, ports, subnet, random env file), removed afterwards.
// It runs like the server: OpenBao initialised, unsealed and configured with the bootstrap script;
// `bootstrap.sh api-credentials` stores the platform_app password at kv/api/database and delivers
// the AppRole credentials; sdlc-api (profile "platform") reads its database password from OpenBao.
// The first admin and its token come from `sdlc admin bootstrap`. Key shares, tokens and passwords
// are THROW-AWAY TEST KEYS: kept in variables, never printed, never in an assertion message.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { processContext, runCli, type CliContext } from '../../../apps/cli/src/index.js';
import { createKysely } from '../../../packages/core/src/db/connection.js';
import { migrateToLatest } from '../../../packages/core/src/db/migrator.js';
import { PlatformDatabase } from '../../../packages/core/src/db/platform-database.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { deployDir, parseEnvFile } from '../../deploy/compose';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_API_TEST === '1';
const PORT_OFFSET = 24000;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!enabled)('sdlc-api container (live)', { timeout: 120_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-api-it-'));
  const envFile = path.join(tmp, 'it.env');
  const project = `sdlcapi${process.pid}`;
  const subnet = `172.30.${150 + (process.pid % 25)}.0/24`;
  const gatewayIp = subnet.replace(/0\/24$/, '1');
  const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');
  const apiUrl = `http://127.0.0.1:${8090 + PORT_OFFSET}`;

  const secrets: string[] = [];
  const keep = (value: string): string => {
    if (value) secrets.push(value);
    return value;
  };
  const redact = (text: string): string =>
    secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);
  let rootToken = '';
  let apiToken = '';
  let appUrl = '';
  let db: PlatformDatabase;

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
    if (r.status !== 0) {
      throw new Error(`${what} failed (exit ${r.status}): ${redact(r.stderr + r.stdout)}`);
    }
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
  const upApi = () => {
    const r = compose(
      '',
      '--profile',
      'core',
      '--profile',
      'platform',
      'up',
      '-d',
      '--build',
      '--wait',
      '--wait-timeout',
      '120',
      'sdlc-api',
    );
    if (r.status !== 0) {
      const logs = compose('', 'logs', '--no-color', 'sdlc-api');
      throw new Error(`sdlc-api did not start: ${redact(logs.stdout + logs.stderr).slice(-3000)}`);
    }
  };

  async function cli(argv: string[]): Promise<{ code: number; out: string }> {
    const out: string[] = [];
    const ctx: CliContext = {
      env: { SDLC_DB_URL: appUrl },
      stdout: (line) => out.push(line),
      stderr: () => undefined,
      connect: processContext().connect,
    };
    return { code: await runCli(argv, ctx), out: out.join('\n') };
  }

  const get = (route: string, token = apiToken) =>
    fetch(`${apiUrl}${route}`, { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
    const text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
      project,
      subnet,
      gateway: gatewayIp,
      portOffset: PORT_OFFSET,
    });
    fs.writeFileSync(envFile, text, { mode: 0o600 });
    const env = parseEnvFile(text);
    keep(env.get('PLATFORM_APP_DB_PASSWORD')!);
    keep(env.get('PLATFORM_DB_PASSWORD')!);

    ok(compose('', '--profile', 'core', 'up', '-d', '--wait', 'openbao', 'postgres'), 'compose up');
    const init = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
    const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
    rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
    ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
    ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');

    const pgUrl = (user: string, password: string) =>
      `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${5432 + PORT_OFFSET}/platform`;
    const owner = createKysely({
      connectionString: pgUrl('platform', env.get('PLATFORM_DB_PASSWORD')!),
      maxConnections: 1,
    });
    const { error } = await migrateToLatest(owner);
    await owner.destroy();
    if (error) throw new Error('migration failed', { cause: error });
    appUrl = pgUrl('platform_app', env.get('PLATFORM_APP_DB_PASSWORD')!);
    db = PlatformDatabase.connect({ connectionString: appUrl, maxConnections: 2 });

    ok(bootstrapCmd(['api-credentials'], `${rootToken}\n`), 'api-credentials');
    upApi();

    const boot = await cli([
      'admin',
      'bootstrap',
      '--tenant',
      'internal',
      '--tenant-name',
      'Internal',
      '--email',
      'admin@example.com',
      '--name',
      'Admin',
      '--json',
    ]);
    if (boot.code !== 0) throw new Error('sdlc admin bootstrap failed');
    apiToken = keep((JSON.parse(boot.out) as { token: string }).token);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
    compose(
      '',
      '--profile',
      'core',
      '--profile',
      'platform',
      'down',
      '--volumes',
      '--remove-orphans',
    );
    fs.rmSync(tmp, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  it('answers with the bootstrap token, using the database password from OpenBao', async () => {
    expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
    const me = await get('/v1/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe('admin@example.com');
    expect((await get('/v1/me', `sdlc_pat_${'x'.repeat(43)}`)).status).toBe(401);
  });

  it('creates an intent through the API once the admin holds person_a on a project', async () => {
    const tenant = await db.system.getTenantBySlug('internal');
    const scope = db.forTenant(parseTenantId(tenant!.id));
    const user = await scope.users.getByEmail('admin@example.com');
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'org/shop',
    });
    await scope.roleBindings.grant({ user_id: user!.id, project_id: project.id, role: 'person_a' });
    const created = await fetch(`${apiUrl}/v1/intents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        project: 'shop',
        title: 'T01',
        risk_tier: 'low',
        data_class: 'internal',
      }),
    });
    expect(created.status).toBe(201);
  });

  it('holds no secret in its environment, image or logs', () => {
    const container = ok(compose('', 'ps', '-q', 'sdlc-api'), 'ps').stdout.trim();
    const inspect = ok(run('docker', ['inspect', container]), 'inspect').stdout;
    const logs = ok(compose('', 'logs', 'sdlc-api'), 'logs');
    for (const secret of secrets) {
      expect(inspect.includes(secret), 'a secret is in docker inspect').toBe(false);
      expect((logs.stdout + logs.stderr).includes(secret), 'a secret is in the logs').toBe(false);
    }
    const files = ok(
      compose('', 'exec', '-T', 'sdlc-api', 'sh', '-c', 'stat -c "%a %U" /run/sdlc/approle/*'),
      'stat',
    ).stdout.trim();
    expect(files.split('\n')).toEqual(['600 node', '600 node']);
  });

  it('api-credentials can run again (rotation); the API starts with the new secret ID', async () => {
    ok(bootstrapCmd(['api-credentials'], `${rootToken}\n`), 'api-credentials again');
    ok(compose('', '--profile', 'core', '--profile', 'platform', 'restart', 'sdlc-api'), 'restart');
    upApi();
    // The HTTP client may still hold a keep-alive socket to the old container: retry once.
    const status = await get('/v1/me').then(
      (r) => r.status,
      () => get('/v1/me').then((r) => r.status),
    );
    expect(status).toBe(200);
  });
});
