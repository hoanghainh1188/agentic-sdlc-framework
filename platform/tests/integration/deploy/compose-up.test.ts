// D-08 task A02: live Docker Compose test (AC1–AC4).
// Needs Docker. Skipped unless SDLC_COMPOSE_IT=1. Run with: pnpm test:compose
// Uses a unique project name, its own ports and a throw-away env file with random secrets;
// everything (containers, volumes, env file) is removed afterwards.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir, parseEnvFile } from '../../deploy/compose';
import {
  hostPortBindings,
  isolateEnv,
  networkGateways,
  sealStatusOnNetwork,
} from '../throwaway-compose';

const enabled = process.env.SDLC_COMPOSE_IT === '1';
const PORT_OFFSET = 20000;
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const TEST_TIMEOUT_MS = 2 * 60 * 1000;

describe.skipIf(!enabled)(
  'Docker Compose infrastructure (live)',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-compose-it-'));
    const envFile = path.join(tmp, 'it.env');
    const project = `sdlcit${process.pid}`;
    const subnet = `172.30.${200 + (process.pid % 25)}.0/24`;
    let vars = new Map<string, string>();

    const hostPort = (name: string): number => Number(vars.get(name));
    const compose = (...args: string[]): string =>
      execFileSync(
        'docker',
        [
          'compose',
          '-f',
          path.join(deployDir, 'docker-compose.yml'),
          '--env-file',
          envFile,
          ...args,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    const up = (...profiles: string[]): string =>
      execFileSync(path.join(deployDir, 'scripts/up.sh'), profiles, {
        encoding: 'utf8',
        env: { ...process.env, SDLC_ENV_FILE: envFile, SDLC_WAIT_TIMEOUT: '600' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const exec = (service: string, ...cmd: string[]): string =>
      compose('exec', '-T', service, ...cmd);

    beforeAll(() => {
      execFileSync(path.join(deployDir, 'scripts/init-env.sh'), [envFile]);
      // Own project name, ports and subnet, so the test never touches a developer's running
      // stack (two Compose networks cannot share a subnet: A03, A11).
      const text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
        project,
        subnet,
        gateway: subnet.replace(/0\/24$/, '1'),
        portOffset: PORT_OFFSET,
      });
      fs.writeFileSync(envFile, text, { mode: 0o600 });
      vars = parseEnvFile(text);
    });

    afterAll(() => {
      try {
        compose(
          '--profile',
          'core',
          '--profile',
          'observability',
          'down',
          '-v',
          '--remove-orphans',
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, SETUP_TIMEOUT_MS);

    describe('AC1 + AC3: core profile becomes healthy', () => {
      beforeAll(() => {
        up('core');
      }, SETUP_TIMEOUT_MS);

      it('reports every long-running service healthy and every job completed', () => {
        const lines = compose(
          '--profile',
          'core',
          'ps',
          '-a',
          '--format',
          '{{.Service}} {{.State}} {{.Health}} {{.ExitCode}}',
        )
          .trim()
          .split('\n');
        const byService = new Map(lines.map((l) => [l.split(' ')[0]!, l]));
        for (const job of ['temporal-schema', 'temporal-namespace', 'seaweedfs-init']) {
          expect(byService.get(job)).toBe(`${job} exited  0`);
        }
        for (const svc of [
          'postgres',
          'temporal',
          'temporal-ui',
          'valkey',
          'litellm',
          'seaweedfs',
          'openbao',
        ]) {
          expect(byService.get(svc)).toBe(`${svc} running healthy 0`);
        }
      });

      it('has separate PostgreSQL databases, each owned by its own role', () => {
        const out = exec(
          'postgres',
          'psql',
          '-U',
          'postgres',
          '-Atc',
          "select datname || ':' || pg_get_userbyid(datdba) from pg_database where not datistemplate order by 1",
        );
        expect(out.trim().split('\n')).toEqual(
          expect.arrayContaining([
            'platform:platform',
            'temporal:temporal',
            'temporal_visibility:temporal',
            'litellm:litellm',
            'langfuse:langfuse',
          ]),
        );
      });

      it('has the Temporal namespace with the configured retention', () => {
        const out = compose(
          'run',
          '--rm',
          '--no-deps',
          '--entrypoint',
          'temporal',
          'temporal-namespace',
          'operator',
          'namespace',
          'describe',
          '--address',
          'temporal:7233',
          '--namespace',
          'default',
          '--output',
          'json',
        );
        const described = JSON.parse(out) as { config: { workflowExecutionRetentionTtl: string } };
        expect(described.config.workflowExecutionRetentionTtl).toBe(`${30 * 24 * 3600}s`);
      });

      it('LiteLLM is ready with its database connected', async () => {
        const res = await fetch(
          `http://127.0.0.1:${hostPort('LITELLM_HOST_PORT')}/health/readiness`,
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ status: 'healthy', db: 'connected' });
      });

      it('Valkey requires a password and uses maxmemory with noeviction', () => {
        const auth = ['env', `REDISCLI_AUTH=${vars.get('VALKEY_PASSWORD')}`, 'valkey-cli'];
        expect(exec('valkey', ...auth, 'config', 'get', 'maxmemory-policy')).toContain(
          'noeviction',
        );
        expect(exec('valkey', ...auth, 'config', 'get', 'maxmemory')).toContain(
          String(256 * 1024 * 1024),
        );
        expect(exec('valkey', 'valkey-cli', 'ping')).toContain('NOAUTH');
        // No process argument carries the password; valkey-server runs as the valkey user.
        const processes = exec('valkey', 'ps', '-o', 'user,args');
        expect(processes).not.toContain(vars.get('VALKEY_PASSWORD'));
        expect(processes).toMatch(/^\s*valkey\s+valkey-server /m);
      });

      it('SeaweedFS has the buckets and refuses anonymous S3 access', async () => {
        const buckets = compose(
          'exec',
          '-T',
          'seaweedfs',
          'sh',
          '-c',
          'echo s3.bucket.list | weed shell -master=localhost:9333',
        );
        expect(buckets).toMatch(/\bevidence\b/);
        expect(buckets).toMatch(/\blangfuse\b/);
        const res = await fetch(`http://127.0.0.1:${hostPort('SEAWEEDFS_S3_HOST_PORT')}/evidence`);
        expect(res.status).toBe(403);
      });

      it('OpenBao API is reachable on the Compose network but NOT initialised or unsealed (A03 does that)', async () => {
        expect(await sealStatusOnNetwork(`${project}-net`)).toMatchObject({
          initialized: false,
          sealed: true,
        });
      });

      it('OpenBao publishes no port on the host; the gateway is pinned (A11)', () => {
        const bindings = hostPortBindings(compose('ps', '-q', 'openbao').trim());
        for (const [port, binding] of Object.entries(bindings)) expect(binding, port).toBeNull();
        expect(networkGateways(`${project}-net`)).toEqual([subnet.replace(/0\/24$/, '1')]);
      });

      it('Temporal UI answers', async () => {
        const res = await fetch(`http://127.0.0.1:${hostPort('TEMPORAL_UI_HOST_PORT')}/`);
        expect(res.status).toBe(200);
      });

      it(
        'a second start is idempotent (jobs re-run and succeed)',
        () => {
          expect(up('core')).toContain('all services healthy, all jobs completed');
        },
        SETUP_TIMEOUT_MS,
      );
    });

    describe('AC2 + AC3: observability profile becomes healthy', () => {
      const langfuse = (p: string): string =>
        `http://127.0.0.1:${hostPort('LANGFUSE_HOST_PORT')}${p}`;
      const basicAuth = (): string =>
        'Basic ' +
        Buffer.from(
          `${vars.get('LANGFUSE_INIT_PROJECT_PUBLIC_KEY')}:${vars.get('LANGFUSE_INIT_PROJECT_SECRET_KEY')}`,
        ).toString('base64');

      beforeAll(() => {
        up('core', 'observability');
      }, SETUP_TIMEOUT_MS);

      it('reports Langfuse web, worker and ClickHouse healthy', () => {
        const out = compose(
          '--profile',
          'observability',
          'ps',
          '--format',
          '{{.Service}} {{.Health}}',
        );
        for (const svc of ['clickhouse', 'langfuse-web', 'langfuse-worker'])
          expect(out).toContain(`${svc} healthy`);
      });

      it('Langfuse is up and the headless-init project works with the generated keys', async () => {
        expect(await (await fetch(langfuse('/api/public/health'))).json()).toMatchObject({
          status: 'OK',
        });
        const res = await fetch(langfuse('/api/public/projects'), {
          headers: { authorization: basicAuth() },
        });
        expect(await res.json()).toMatchObject({
          data: [{ id: 'sdlc-platform', organization: { id: 'sdlc' } }],
        });
      });

      it('Langfuse refuses open sign-up', async () => {
        const res = await fetch(langfuse('/api/auth/signup'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'x',
            email: 'intruder@example.com',
            password: 'Intruder-password-123',
          }),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(await res.text()).toContain('Sign up is disabled');
      });

      it('stores OpenTelemetry trace uploads in SeaweedFS (bucket "langfuse")', async () => {
        const now = String(BigInt(Date.now()) * 1_000_000n);
        const res = await fetch(langfuse('/api/public/otel/v1/traces'), {
          method: 'POST',
          headers: { authorization: basicAuth(), 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceSpans: [
              {
                resource: {
                  attributes: [{ key: 'service.name', value: { stringValue: 'a02-it' } }],
                },
                scopeSpans: [
                  {
                    scope: { name: 'a02-it' },
                    spans: [
                      {
                        traceId: '0af7651916cd43dd8448eb211c80319c',
                        spanId: 'b7ad6b7169203331',
                        name: 'a02-it',
                        kind: 1,
                        startTimeUnixNano: now,
                        endTimeUnixNano: now,
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        });
        expect(res.status).toBe(200);
        const listing = compose(
          'exec',
          '-T',
          'seaweedfs',
          'sh',
          '-c',
          'echo "fs.ls /buckets/langfuse/events/otel/sdlc-platform" | weed shell -master=localhost:9333',
        );
        expect(listing).toMatch(/\d{4}/);
      });
    });
  },
);
