// D-08 task A08 AC3 (design/ADR-M35 §2.4; QUESTIONS #4, answer A): with the Compose profile
// "observability", one model call through LiteLLM creates a Langfuse v4 trace that carries all
// seven labels (tenant, project, intent_id, run_id, gate, agent, data_class; FR-31). LiteLLM's
// `langfuse_otel` sends the span to the OpenTelemetry Collector, which forwards it to Langfuse.
// Also: a span from a platform process (service `sdlc-api`) reaches Langfuse through the same
// collector (AC2's pipeline), and the collector is not reachable from the host.
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

import { LiteLLMGateway } from '@sdlc/adapter-model-litellm';
import { COST_LABEL_NAMES, type CostLabels } from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CostController } from '../../../packages/core/src/cost/index.js';
import { createKysely } from '../../../packages/core/src/db/connection.js';
import { migrateToLatest } from '../../../packages/core/src/db/migrator.js';
import { PlatformDatabase } from '../../../packages/core/src/db/platform-database.js';
import { deployDir, parseEnvFile, root } from '../../deploy/compose';
import { seedRun } from '../cost-seed';
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
      const owner = createKysely({
        connectionString: pgUrl('platform', env.get('PLATFORM_DB_PASSWORD')!),
        maxConnections: 1,
      });
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
      run('docker', ['rm', '-f', stubName]);
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
  },
);
