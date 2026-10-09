// D-08 task A08 AC3 (design/ADR-M35 §2.4; QUESTIONS #4, answer A): with the Compose profile
// "observability", one model call through LiteLLM creates a Langfuse v4 trace that carries all
// seven labels (tenant, project, intent_id, run_id, gate, agent, data_class; FR-31). LiteLLM's
// `langfuse_otel` sends the span to the OpenTelemetry Collector, which forwards it to Langfuse.
// Also: a span from a platform process (service `sdlc-api`) reaches Langfuse through the same
// collector (AC2's pipeline), and the collector is not reachable from the host.
//
// D-08 E08 AC4 (design/ADR-M53): `openbao:bootstrap worker-langfuse-credentials` (with the init
// key, QUESTIONS #252), model calls of two projects of one tenant, one project archived, the
// retention pass with the worker's own stores: the archived project's traces are gone from
// Langfuse and from ClickHouse's disk (`apply_deleted_mask=0`), the other project's stay; the raw
// OTLP files are swept; `project.purged` records `langfuse: purged`; the identities' limits.
//
// Needs Docker. Skipped unless SDLC_OBSERVABILITY_TEST=1. Run with: pnpm test:observability
// Own throw-away Compose project (own name, ports, subnet, random env file), removed afterwards.
// A stub model stands in for a provider: no provider key. Keys and tokens are THROW-AWAY TEST
// KEYS, kept in variables of this process, never printed (errors go through redact()).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { S3RetentionStore } from '@sdlc/adapter-evidence-s3';
import { LangfuseTraceStore } from '@sdlc/adapter-traces-langfuse';
import { LiteLLMGateway } from '@sdlc/adapter-model-litellm';
import {
  COST_LABEL_NAMES,
  EvidenceError,
  type CostLabels,
  type EvidenceRetentionStore,
} from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { archiveProject } from '../../../packages/core/src/admin/projects.js';
import { CostController } from '../../../packages/core/src/cost/index.js';
import { createKysely } from '../../../packages/core/src/db/connection.js';
import { migrateToLatest } from '../../../packages/core/src/db/migrator.js';
import { PlatformDatabase } from '../../../packages/core/src/db/platform-database.js';
import { deployDir, parseEnvFile, root } from '../../deploy/compose';
import {
  runRetentionPass,
  type RetentionPassResult,
} from '../../../packages/core/src/retention/pass.js';
import type { LangfusePurgeState } from '../../../packages/core/src/retention/langfuse-pass.js';
import { seedOtherProject, seedRun } from '../cost-seed';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_OBSERVABILITY_TEST === '1';
const LITELLM_DIR = path.join(root, 'platform/tests/integration/litellm');
const PORT_OFFSET = 27000;
const SETUP_TIMEOUT_MS = 12 * 60 * 1000;
const TEST_TIMEOUT_MS = 4 * 60 * 1000;
// Same pinned image as the other live tests.
const NODE_IMAGE =
  'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
const MODEL = 'stub-model';
const PROFILES = ['--profile', 'core', '--profile', 'models', '--profile', 'observability'];

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * An observation of the Langfuse v4 read API (`/api/public/v2/observations`). The deployment runs
 * v4 in `events_only` mode, where the legacy traces API answers 404. Span attributes are in
 * `metadata`: the trace tags as `attributes.langfuse.trace.tags`, the service as
 * `resourceAttributes.service.name`.
 */
interface LangfuseObservation {
  readonly id: string;
  readonly traceId: string;
  readonly type: string;
  readonly name?: string;
  readonly metadata?: Record<string, unknown>;
}

const TRACE_TAGS = 'attributes.langfuse.trace.tags';
const SERVICE_NAME = 'resourceAttributes.service.name';

describe.skipIf(!enabled)(
  'A08: traces reach Langfuse through the collector (live)',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-obs-it-'));
    const envFile = path.join(tmp, 'it.env');
    const project = `sdlcobs${process.pid}`;
    const network = `${project}-net`;
    const subnet = `172.30.${50 + (process.pid % 50)}.0/24`;
    const gatewayIp = subnet.replace(/0\/24$/, '1');
    const stubName = `${project}-stub`;
    const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');
    const litellmUrl = `http://127.0.0.1:${4000 + PORT_OFFSET}`;
    const langfuseUrl = `http://127.0.0.1:${3000 + PORT_OFFSET}`;
    const now = new Date();

    const secrets: string[] = [];
    const keep = (value: string): string => {
      if (value) secrets.push(value);
      return value;
    };
    const redact = (text: string): string =>
      secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);
    const masterKey = keep(`sk-it-master-${crypto.randomBytes(16).toString('hex')}`);
    const saltKey = keep(`sk-it-salt-${crypto.randomBytes(16).toString('hex')}`);
    const providerKey = keep(`sk-it-provider-${crypto.randomBytes(16).toString('hex')}`);
    let rootToken = '';
    let langfuseAuth = '';

    let db: PlatformDatabase;
    let controller: CostController;
    let envMap: Map<string, string>;
    let ownerUrl = '';
    const chProxyName = `${project}-chproxy`;
    const clickhouseUrl = `http://127.0.0.1:${8123 + PORT_OFFSET}`;

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
        [
          'compose',
          '-f',
          path.join(deployDir, 'docker-compose.yml'),
          '--env-file',
          envFile,
          ...args,
        ],
        input,
      );
    const bootstrapCmd = (args: string[], input = ''): Result =>
      run(bootstrap, args, input, { SDLC_OPENBAO_TEST: '1' });
    const admin = (script: string, input = ''): string =>
      ok(
        compose(
          `${rootToken}\n${input}`,
          'exec',
          '-T',
          'openbao',
          'sh',
          '-c',
          `IFS= read -r t; export BAO_TOKEN="$t"; ${script}`,
        ),
        'admin command',
      ).stdout.trim();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    async function langfuse<T>(pathAndQuery: string): Promise<T> {
      const response = await fetch(`${langfuseUrl}${pathAndQuery}`, {
        headers: { authorization: `Basic ${langfuseAuth}` },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`langfuse ${pathAndQuery}: ${response.status}`);
      return JSON.parse(text) as T;
    }

    /** Polls Langfuse until an observation matches `match` (ingestion is asynchronous). */
    async function waitForObservation(
      match: (o: LangfuseObservation) => boolean,
      fields = 'core,basic,metadata',
    ): Promise<LangfuseObservation> {
      for (let i = 0; i < 90; i++) {
        const list = await langfuse<{ data: LangfuseObservation[] }>(
          `/api/public/v2/observations?limit=100&fields=${fields}`,
        );
        const found = list.data.find(match);
        if (found) return found;
        await sleep(2000);
      }
      throw new Error('no matching observation in Langfuse');
    }

    beforeAll(async () => {
      // Environment like the server: keys from OpenBao, the test template (stub model), and the
      // OTLP endpoint of the collector (what up.sh sets with the profile observability).
      ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
      let text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
        project,
        subnet,
        gateway: gatewayIp,
        portOffset: PORT_OFFSET,
      });
      text = text
        .replace(/^LITELLM_MASTER_KEY=.*$/m, 'LITELLM_MASTER_KEY=')
        .replace(/^LITELLM_SALT_KEY=.*$/m, 'LITELLM_SALT_KEY=')
        .replace(
          /^SDLC_LITELLM_TEMPLATE=.*$/m,
          `SDLC_LITELLM_TEMPLATE=${path.join(LITELLM_DIR, 'config.test.ctmpl')}`,
        )
        .replace(/^SDLC_OTEL_ENDPOINT=.*$/m, 'SDLC_OTEL_ENDPOINT=http://otel-collector:4318');
      fs.writeFileSync(envFile, text, { mode: 0o600 });
      const env = parseEnvFile(text);
      envMap = env;
      langfuseAuth = keep(
        Buffer.from(
          `${env.get('LANGFUSE_INIT_PROJECT_PUBLIC_KEY')!}:${env.get('LANGFUSE_INIT_PROJECT_SECRET_KEY')!}`,
        ).toString('base64'),
      );
      keep(env.get('LANGFUSE_INIT_PROJECT_SECRET_KEY')!);

      ok(compose('', '--profile', 'core', 'up', '-d', '--wait', 'openbao'), 'compose up openbao');
      const init = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
      const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
      ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
      ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');
      admin(
        'IFS= read -r m; IFS= read -r s; IFS= read -r p; ' +
          'printf %s "$m" | bao kv put -mount=kv cost-controller/litellm-master-key value=- >/dev/null && ' +
          'printf %s "$s" | bao kv put -mount=kv litellm/salt-key value=- >/dev/null && ' +
          'printf %s "$p" | bao kv put -mount=kv litellm/providers/stub api_key=- >/dev/null',
        `${masterKey}\n${saltKey}\n${providerKey}\n`,
      );
      ok(bootstrapCmd(['litellm-credentials'], `${rootToken}\n`), 'litellm-credentials');

      ok(run('docker', ['pull', '-q', NODE_IMAGE]), 'pull node image');
      ok(
        run(
          'docker',
          [
            'run',
            '-d',
            '--name',
            stubName,
            '--network',
            network,
            '--network-alias',
            'stub-model',
            '-e',
            'STUB_EXPECTED_KEY',
            '-v',
            `${path.join(LITELLM_DIR, 'stub-model.mjs')}:/stub.mjs:ro`,
            NODE_IMAGE,
            'node',
            '/stub.mjs',
          ],
          '',
          { STUB_EXPECTED_KEY: providerKey },
        ),
        'start stub model',
      );
      ok(compose('', ...PROFILES, 'build', 'otel-collector'), 'build otel-collector');
      ok(
        compose(
          '',
          ...PROFILES,
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '600',
          'postgres',
          'valkey',
          'litellm-agent',
          'litellm',
          'langfuse-web',
          'langfuse-worker',
          'otel-collector',
        ),
        'compose up litellm, langfuse and the collector',
      );

      const pgUrl = (user: string, password: string) =>
        `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${5432 + PORT_OFFSET}/platform`;
      ownerUrl = pgUrl('platform', env.get('PLATFORM_DB_PASSWORD')!);
      keep(env.get('PLATFORM_DB_PASSWORD')!);
      const owner = createKysely({ connectionString: ownerUrl, maxConnections: 1 });
      const { error } = await migrateToLatest(owner);
      await owner.destroy();
      if (error) throw new Error('migration failed', { cause: error });
      db = PlatformDatabase.connect({
        connectionString: pgUrl('platform_app', env.get('PLATFORM_APP_DB_PASSWORD')!),
        maxConnections: 4,
      });
      const gateway = new LiteLLMGateway({
        baseUrl: litellmUrl,
        masterKey: new Redacted(masterKey),
      });
      controller = new CostController({ gateway, db });
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await db?.close();
      // Debugging only: keep the throw-away stack (remove it with `docker compose -p <project> down -v`).
      if (process.env.SDLC_OBSERVABILITY_KEEP === '1') return;
      run('docker', ['rm', '-f', stubName, chProxyName]);
      compose('', ...PROFILES, 'down', '--volumes', '--remove-orphans');
      fs.rmSync(tmp, { recursive: true, force: true });
    }, SETUP_TIMEOUT_MS);

    it('AC3: one model call makes a Langfuse trace with all seven labels', async () => {
      const seeded = await seedRun(db, { slug: 'obs-1', models: [MODEL], now });
      const issued = await controller.issueRunKey({
        tenantId: seeded.scope.tenantId,
        runId: seeded.runId,
        gate: 'G4',
        agent: 'coder-openhands',
      });
      const labels: CostLabels = issued.labels;
      const response = await fetch(`${litellmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${issued.key.key.reveal()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await response.text();
      expect(response.status).toBe(200);

      const tagsOf = (o: LangfuseObservation): unknown[] => {
        const tags = o.metadata?.[TRACE_TAGS];
        return Array.isArray(tags) ? tags : [];
      };
      const generation = await waitForObservation(
        (o) => o.type === 'GENERATION' && tagsOf(o).includes(`run_id:${labels.run_id}`),
      );
      expect(generation.metadata?.[SERVICE_NAME]).toBe('sdlc-litellm');
      // Condition 3 of the plan approval: every label is a trace tag, or the task stops
      // (QUESTIONS #135). The tags are `<label>:<value>`, as on the virtual key (ADR-M24 §2.2).
      const missing = COST_LABEL_NAMES.filter(
        (name) => !tagsOf(generation).includes(`${name}:${labels[name]}`),
      );
      expect(missing).toEqual([]);
      // The virtual key never reaches Langfuse (all fields, input and output included).
      const full = await waitForObservation(
        (o) => o.id === generation.id,
        'core,basic,usage,io,metadata,model,prompt,time,trace',
      );
      expect(JSON.stringify(full)).not.toContain(issued.key.key.reveal());
    });

    it('AC2 pipeline: a span of a platform process reaches Langfuse through the collector', async () => {
      const traceId = crypto.randomBytes(16).toString('hex');
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      const body = JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { stringValue: 'sdlc-api' } }],
            },
            scopeSpans: [
              {
                scope: { name: '@sdlc/telemetry' },
                spans: [
                  {
                    traceId,
                    spanId: crypto.randomBytes(8).toString('hex'),
                    name: 'GET /v1/intents',
                    kind: 2,
                    startTimeUnixNano: String(nowNs - 5_000_000n),
                    endTimeUnixNano: String(nowNs),
                  },
                ],
              },
            ],
          },
        ],
      });
      // From a container on the Compose network: the collector has no host port.
      ok(
        run(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            network,
            '-e',
            'BODY',
            NODE_IMAGE,
            'node',
            '-e',
            "fetch('http://otel-collector:4318/v1/traces',{method:'POST',headers:{'content-type':'application/json'},body:process.env.BODY}).then(r=>{if(!r.ok)process.exit(1)})",
          ],
          '',
          { BODY: body },
        ),
        'send an OTLP span to the collector',
      );
      const span = await waitForObservation((o) => o.traceId === traceId);
      expect(span.name).toBe('GET /v1/intents');
      expect(span.metadata?.[SERVICE_NAME]).toBe('sdlc-api');
    });

    it('condition 1: the collector has no host port and is on the Compose network only', () => {
      const id = ok(compose('', ...PROFILES, 'ps', '-q', 'otel-collector'), 'ps').stdout.trim();
      const inspect = JSON.parse(ok(run('docker', ['inspect', id]), 'inspect').stdout) as {
        HostConfig: { PortBindings: Record<string, unknown> | null };
        NetworkSettings: { Networks: Record<string, unknown> };
      }[];
      expect(Object.keys(inspect[0]!.HostConfig.PortBindings ?? {})).toEqual([]);
      expect(Object.keys(inspect[0]!.NetworkSettings.Networks)).toEqual([network]);
    });

    it("E08 AC4: the purge deletes one project's traces, on disk too; another project's stay", async () => {
      // The worker's credentials, made by the real command. The test uses Langfuse's init key as
      // the worker's key (QUESTIONS #252); on a server it is a second key made in the UI.
      const publicKey = envMap.get('LANGFUSE_INIT_PROJECT_PUBLIC_KEY')!;
      const secretKey = envMap.get('LANGFUSE_INIT_PROJECT_SECRET_KEY')!;
      const boot = ok(
        bootstrapCmd(['worker-langfuse-credentials'], `${rootToken}\n${publicKey}\n${secretKey}\n`),
        'worker-langfuse-credentials',
      );
      const entry = JSON.parse(admin('bao kv get -format=json -mount=kv worker/langfuse')) as {
        data: { data: Record<string, string> };
      };
      const fields = entry.data.data;
      for (const value of Object.values(fields)) keep(value);
      // Prints no secret.
      for (const value of Object.values(fields))
        expect(boot.stdout + boot.stderr).not.toContain(value);
      expect(Object.keys(fields).sort()).toEqual([
        'access_key',
        'clickhouse_password',
        'langfuse_public_key',
        'langfuse_secret_key',
        'secret_key',
      ]);

      // ClickHouse has no host port: a small TCP relay on the throw-away network, for the test only.
      ok(
        run('docker', [
          'run',
          '-d',
          '--name',
          chProxyName,
          '--network',
          network,
          '-p',
          `127.0.0.1:${8123 + PORT_OFFSET}:8123`,
          NODE_IMAGE,
          'node',
          '-e',
          "const n=require('net');n.createServer(c=>{const s=n.connect(8123,'clickhouse');c.pipe(s).pipe(c);c.on('error',()=>s.destroy());s.on('error',()=>c.destroy())}).listen(8123)",
        ]),
        'start the ClickHouse relay',
      );
      const clickhouse = async (user: string, password: string, query: string) => {
        const r = await fetch(`${clickhouseUrl}/?mutations_sync=1`, {
          method: 'POST',
          headers: { 'x-clickhouse-user': user, 'x-clickhouse-key': password },
          body: query,
        });
        return { status: r.status, text: (await r.text()).trim() };
      };
      for (let i = 0; ; i++) {
        const ping = await fetch(`${clickhouseUrl}/ping`).catch(() => undefined);
        if (ping?.ok) break;
        if (i >= 30) throw new Error('the ClickHouse relay does not answer');
        await sleep(1000);
      }

      // The identities' limits. sdlc_purge reads nothing.
      expect(
        (
          await clickhouse(
            'sdlc_purge',
            fields.clickhouse_password!,
            'SELECT count() FROM default.events_full',
          )
        ).status,
      ).not.toBe(200);
      // A10 (ADR-M63 §6): over the network, nobody manages ClickHouse users. `langfuse` has no
      // access management; `sdlc_admin` (which made sdlc_purge above) answers on loopback only.
      const created = await clickhouse(
        'langfuse',
        envMap.get('CLICKHOUSE_PASSWORD')!,
        "CREATE USER sdlc_a10_probe IDENTIFIED WITH sha256_password BY 'probe-a10'",
      );
      expect(created.status).not.toBe(200);
      expect(created.text).toContain('ACCESS_DENIED');
      const remoteAdmin = await clickhouse('sdlc_admin', '', 'SELECT 1');
      expect(remoteAdmin.status).not.toBe(200);
      expect(remoteAdmin.text).toContain('AUTHENTICATION_FAILED');
      const s3Endpoint = `http://127.0.0.1:${envMap.get('SEAWEEDFS_S3_HOST_PORT')!}`;
      const s3 = new S3Client({
        endpoint: s3Endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: fields.access_key!, secretAccessKey: fields.secret_key! },
      });
      const refused = async (send: () => Promise<unknown>) => {
        const error = await send().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(S3ServiceException);
        expect((error as S3ServiceException).$metadata.httpStatusCode).toBe(403);
      };

      // Two projects of one tenant make model calls through LiteLLM.
      const a = await seedRun(db, { slug: 'obs-lf', models: [MODEL], now });
      await a.scope.tenantRoles.grant({ user_id: a.personA, role: 'tenant_admin' });
      const b = await seedOtherProject(a, { slug: 'warehouse', models: [MODEL], now });
      const traceOf: Record<string, string> = {};
      for (const runId of [a.runId, b.runId]) {
        const issued = await controller.issueRunKey({
          tenantId: a.scope.tenantId,
          runId,
          gate: 'G4',
          agent: 'coder-openhands',
        });
        const response = await fetch(`${litellmUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${issued.key.key.reveal()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
        });
        await response.text();
        expect(response.status).toBe(200);
        const generation = await waitForObservation(
          (o) =>
            o.type === 'GENERATION' &&
            Array.isArray(o.metadata?.[TRACE_TAGS]) &&
            (o.metadata[TRACE_TAGS] as unknown[]).includes(`run_id:${runId}`),
        );
        traceOf[runId] = generation.traceId;
      }
      const onDisk = async (traceId: string) => {
        let total = 0;
        for (const table of ['events_full', 'events_core']) {
          const r = await clickhouse(
            'langfuse',
            envMap.get('CLICKHOUSE_PASSWORD')!,
            `SELECT count() FROM default.${table} WHERE trace_id = '${traceId}' SETTINGS apply_deleted_mask = 0`,
          );
          expect(r.status).toBe(200);
          total += Number(r.text);
        }
        return total;
      };
      expect(await onDisk(traceOf[a.runId]!)).toBeGreaterThan(0);

      // Raw OTLP files: the worker's identity may list them, never read one, never touch another
      // prefix or bucket.
      const rawStore = new S3RetentionStore({
        endpoint: s3Endpoint,
        bucket: 'langfuse',
        prefixes: ['events/otel/'],
        accessKeyId: new Redacted(fields.access_key!),
        secretAccessKey: new Redacted(fields.secret_key!),
      });
      const rawBefore = await rawStore.listKeys('events/otel/', null, 1000);
      expect(rawBefore.keys.length).toBeGreaterThan(0);
      const rawKey = rawBefore.keys[0]!.uri.slice('s3://langfuse/'.length);
      await refused(() => s3.send(new GetObjectCommand({ Bucket: 'langfuse', Key: rawKey })));
      await refused(() => s3.send(new DeleteObjectCommand({ Bucket: 'langfuse', Key: 'media/x' })));
      await refused(() => s3.send(new ListObjectsV2Command({ Bucket: 'evidence' })));

      // Both intents end; the first project is archived.
      const ended = new Date(Date.now() - 86_400_000);
      const owner = createKysely({ connectionString: ownerUrl, maxConnections: 1 });
      await sql`UPDATE intents SET status = 'done', current_gate = NULL, gate_entered_at = NULL,
        updated_at = ${ended} WHERE id IN (${a.intentId}, ${b.intentId})`.execute(owner);
      await owner.destroy();
      await archiveProject(a.scope, { type: 'human', userId: a.personA }, 'shop');
      const archivedAt = new Date(
        (await a.scope.audit.listForEntity(a.projectId)).find(
          (e) => e.action === 'project.archived',
        )!.occurred_at,
      );
      const day = (n: number) => new Date(archivedAt.getTime() + n * 86_400_000);

      const noEvidence: EvidenceRetentionStore = {
        listKeys: () => Promise.resolve({ keys: [], next: null }),
        deleteAllVersions: () => Promise.reject(new EvidenceError('forbidden')),
        setLegalHold: () => Promise.reject(new EvidenceError('forbidden')),
        extendLock: () => Promise.reject(new EvidenceError('forbidden')),
      };
      const state: LangfusePurgeState = { maskOwed: false, maskedOn: null };
      const store = new LangfuseTraceStore({
        url: langfuseUrl,
        publicKey: new Redacted(fields.langfuse_public_key!),
        secretKey: new Redacted(fields.langfuse_secret_key!),
        clickhouse: {
          url: clickhouseUrl,
          user: 'sdlc_purge',
          password: new Redacted(fields.clickhouse_password!),
        },
      });
      const logs: string[] = [];
      const pass = (at: Date): Promise<RetentionPassResult> =>
        runRetentionPass(
          {
            db,
            store: noEvidence,
            logger: {
              log: (level, event, f = {}) => logs.push(JSON.stringify({ level, event, ...f })),
            },
            now: () => at,
            settings: {
              mode: 'purge',
              bucket: 'evidence',
              batch: 200,
              guardPercent: 100,
              guardFloor: 1000,
              archiveGraceDays: 7,
              orphanGraceHours: 24,
            },
            langfuse: {
              status: 'on',
              store,
              rawStore,
              rawPrefix: 'events/otel/',
              settings: {
                batch: 50,
                rawMaxAgeHours: 24,
                rawBatch: 1000,
                // The project Langfuse creates at start (LANGFUSE_INIT_PROJECT_ID).
                projectId: 'sdlc-platform',
                guardPercent: 100,
                guardFloor: 1000,
              },
              state,
            },
          },
          null,
        );

      await pass(day(0)); // schedules the archive purge
      const requested = await pass(day(8));
      expect(requested.langfuseRequested).toBe(1);
      // Langfuse deletes asynchronously: pass again until the purge is confirmed (bounded).
      let compacted = 0;
      for (let i = 1; ; i++) {
        const result = await pass(new Date(day(8).getTime() + i * 60_000));
        compacted += result.langfuseCompacted;
        if ((await a.scope.langfusePurges.get(a.intentId))?.confirmedAt) break;
        if (i >= 45)
          throw new Error(`the Langfuse purge was not confirmed: ${redact(logs.join('\n'))}`);
        await sleep(2000);
      }
      expect(compacted).toBe(1);
      expect(logs.join('\n')).toContain('retention.langfuse_compacted');

      // The archived project's trace is gone from Langfuse and from ClickHouse's disk.
      expect(await store.findTraces({ tags: [`run_id:${a.runId}`], max: 10 })).toEqual([]);
      expect(await onDisk(traceOf[a.runId]!)).toBe(0);
      // The other project's trace stays.
      expect(
        (await store.findTraces({ tags: [`run_id:${b.runId}`], max: 10 })).map((t) => t.traceId),
      ).toEqual([traceOf[b.runId]]);
      expect(await onDisk(traceOf[b.runId]!)).toBeGreaterThan(0);
      // The raw OTLP files older than 24 hours (every tenant) are swept.
      expect((await rawStore.listKeys('events/otel/', null, 1000)).keys).toEqual([]);
      // project.purged records the Langfuse purge.
      const purged = (await a.scope.audit.listForEntity(a.projectId)).filter(
        (e) => e.action === 'project.purged',
      );
      expect(purged.map((e) => e.payload)).toEqual([
        { intents: 1, purged: 0, held: 0, langfuse: 'purged' },
      ]);
      // No secret in a log line.
      for (const value of Object.values(fields)) expect(logs.join('\n')).not.toContain(value);
      rawStore.destroy();
      s3.destroy();
    });
  },
);
