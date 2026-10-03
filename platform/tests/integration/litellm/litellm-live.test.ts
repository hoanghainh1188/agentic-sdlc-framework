// D-08 task C03: live test of LiteLLM with keys from OpenBao and the Cost Controller (AC1–AC5),
// design/ADR-M24. Needs Docker. Skipped unless SDLC_LITELLM_TEST=1. Run with: pnpm test:litellm
//
// Own throw-away Compose project (own name, ports, subnet, random env file), removed afterwards.
// It runs like the server: the Compose profile "models", no LiteLLM master or salt key in .env.
// OpenBao is initialised, unsealed and configured with the bootstrap script; the LiteLLM sidecar
// gets its AppRole credentials from `bootstrap.sh litellm-credentials`. A stub model
// (stub-model.mjs) stands in for a provider and answers only with the throw-away provider key the
// test stores in OpenBao. Key shares, tokens and keys are THROW-AWAY TEST KEYS: kept in variables
// of this process, never printed, never part of an assertion message (errors go through redact()).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LiteLLMGateway, LiteLLMKeySpendReader } from '@sdlc/adapter-model-litellm';
import { COST_LABEL_NAMES } from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CostController, CostError } from '../../../packages/core/src/cost/index.js';
import { createKysely } from '../../../packages/core/src/db/connection.js';
import { migrateToLatest } from '../../../packages/core/src/db/migrator.js';
import { PlatformDatabase } from '../../../packages/core/src/db/platform-database.js';
import { deployDir, parseEnvFile, root } from '../../deploy/compose';
import { issueRun, seedRun, type SeededRun } from '../cost-seed';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_LITELLM_TEST === '1';
const HERE = path.join(root, 'platform/tests/integration/litellm');
const PORT_OFFSET = 23000;
const SETUP_TIMEOUT_MS = 8 * 60 * 1000;
const TEST_TIMEOUT_MS = 3 * 60 * 1000;
// Same pinned image as the other live tests.
const NODE_IMAGE =
  'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
const MODEL = 'stub-model';
// stub-model.mjs: 1000 input tokens (200 cached, free) and 100 output tokens per call.
const COST_PER_CALL = 0.001;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!enabled)(
  'LiteLLM with keys from OpenBao (live)',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-litellm-it-'));
    const envFile = path.join(tmp, 'it.env');
    const project = `sdlclit${process.pid}`;
    const network = `${project}-net`;
    const subnet = `172.30.${200 + (process.pid % 25)}.0/24`;
    const gatewayIp = subnet.replace(/0\/24$/, '1');
    const stubName = `${project}-stub`;
    const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');
    const litellmUrl = `http://127.0.0.1:${4000 + PORT_OFFSET}`;
    const now = new Date();

    // Throw-away secrets, kept in memory only.
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

    let db: PlatformDatabase;
    let gateway: LiteLLMGateway;
    let controller: CostController;
    let tenantCount = 0;

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
    /** Runs `script` in the openbao container with the throw-away root token (from stdin). */
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
    const containerOf = (service: string): string =>
      ok(compose('', 'ps', '-q', service), `ps ${service}`).stdout.trim();

    /** One model call with a virtual key; returns the HTTP status. */
    async function chat(key: string, model = MODEL): Promise<number> {
      const response = await fetch(`${litellmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await response.text();
      return response.status;
    }

    /** An admin call with the master key; returns the raw body text. */
    async function adminGet(pathAndQuery: string): Promise<{ status: number; text: string }> {
      const response = await fetch(`${litellmUrl}${pathAndQuery}`, {
        headers: { authorization: `Bearer ${masterKey}` },
      });
      return { status: response.status, text: await response.text() };
    }

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /** Calls until the gateway refuses (429) or `max` calls; returns the statuses. */
    async function callUntilBlocked(key: string, max: number): Promise<number[]> {
      const statuses: number[] = [];
      for (let i = 0; i < max; i++) {
        const status = await chat(key);
        statuses.push(status);
        if (status === 429) break;
        // LiteLLM updates spend asynchronously; give it a moment between calls (QUESTIONS #14).
        await sleep(700);
      }
      return statuses;
    }

    const seed = (
      options: { monthly?: string | null; intentBudget?: string; runBudget?: string } = {},
    ) => seedRun(db, { ...options, slug: `lit-${String(++tenantCount)}`, models: [MODEL], now });

    const issue = (s: SeededRun, runId = s.runId) =>
      controller.issueRunKey({
        tenantId: s.scope.tenantId,
        runId,
        gate: 'G4',
        agent: 'coder-openhands',
      });

    /** Syncs until the run has `count` cost records (LiteLLM writes spend logs in batches). */
    async function syncUntil(s: SeededRun, runId: string, count: number) {
      const range = {
        from: new Date(now.getTime() - 60_000),
        to: new Date(Date.now() + 60 * 60_000),
      };
      for (let i = 0; i < 60; i++) {
        await controller.syncSpend(range);
        const rows = await s.scope.costRecords.listForRun(runId);
        if (rows.length >= count) return rows;
        await sleep(2000);
      }
      throw new Error(`cost records of run ${runId} did not reach ${count}`);
    }

    beforeAll(async () => {
      // Environment like the server: no LiteLLM master or salt key in .env; the test template.
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
          `SDLC_LITELLM_TEMPLATE=${path.join(HERE, 'config.test.ctmpl')}`,
        );
      fs.writeFileSync(envFile, text, { mode: 0o600 });
      const env = parseEnvFile(text);

      // OpenBao: initialise, unseal, configure (throw-away keys).
      ok(compose('', '--profile', 'core', 'up', '-d', '--wait', 'openbao'), 'compose up openbao');
      const init = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
      const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
      ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
      ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');

      // The keys, passed on stdin (never a command line): master key, salt key, provider key.
      admin(
        'IFS= read -r m; IFS= read -r s; IFS= read -r p; ' +
          'printf %s "$m" | bao kv put -mount=kv cost-controller/litellm-master-key value=- >/dev/null && ' +
          'printf %s "$s" | bao kv put -mount=kv litellm/salt-key value=- >/dev/null && ' +
          'printf %s "$p" | bao kv put -mount=kv litellm/providers/stub api_key=- >/dev/null',
        `${masterKey}\n${saltKey}\n${providerKey}\n`,
      );
      ok(bootstrapCmd(['litellm-credentials'], `${rootToken}\n`), 'litellm-credentials');

      // The stub provider on the Compose network, then the stack with the profile "models".
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
            `${path.join(HERE, 'stub-model.mjs')}:/stub.mjs:ro`,
            NODE_IMAGE,
            'node',
            '/stub.mjs',
          ],
          '',
          { STUB_EXPECTED_KEY: providerKey },
        ),
        'start stub model',
      );
      ok(
        compose(
          '',
          '--profile',
          'core',
          '--profile',
          'models',
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          '300',
          'postgres',
          'valkey',
          'litellm-agent',
          'litellm',
        ),
        'compose up litellm with the profile models',
      );

      // Platform database: migrate as the owner, work as platform_app.
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
      gateway = new LiteLLMGateway({ baseUrl: litellmUrl, masterKey: new Redacted(masterKey) });
      controller = new CostController({ gateway, db });
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await db?.close();
      run('docker', ['rm', '-f', stubName]);
      compose(
        '',
        '--profile',
        'core',
        '--profile',
        'models',
        'down',
        '--volumes',
        '--remove-orphans',
      );
      fs.rmSync(tmp, { recursive: true, force: true });
    }, SETUP_TIMEOUT_MS);

    describe('AC1: provider keys, master key and salt key come from OpenBao only', () => {
      it('LiteLLM serves the stub model, whose provider key exists only in OpenBao', async () => {
        const models = await gateway.listModels();
        expect(models).toEqual([{ model: MODEL, providerType: 'api' }]);
        // A call succeeds only when LiteLLM sends the provider key it got from the sidecar.
        const s = await seed();
        const issued = await issue(s);
        expect(await chat(issued.key.key.reveal())).toBe(200);
      });

      it('the master key from OpenBao works; LiteLLM has no master key in its environment', async () => {
        expect((await adminGet('/key/list')).status).toBe(200);
        const response = await fetch(`${litellmUrl}/key/list`, {
          headers: { authorization: 'Bearer sk-not-the-master-key' },
        });
        expect(response.status).toBe(401);
      });

      it('no container environment, image config or env file holds a key', () => {
        for (const service of ['litellm', 'litellm-agent', 'openbao']) {
          const inspect = ok(
            run('docker', ['inspect', containerOf(service)]),
            `inspect ${service}`,
          ).stdout;
          for (const secret of [providerKey, masterKey, saltKey]) {
            expect(inspect.includes(secret), `${service}: a key is visible in docker inspect`).toBe(
              false,
            );
          }
        }
        const envs = ok(
          run('docker', ['inspect', '-f', '{{json .Config.Env}}', containerOf('litellm')]),
          'env',
        ).stdout;
        expect(JSON.parse(envs)).toEqual(
          expect.arrayContaining(['LITELLM_MASTER_KEY=', 'LITELLM_SALT_KEY=']),
        );
        const envText = fs.readFileSync(envFile, 'utf8');
        for (const secret of [providerKey, masterKey, saltKey]) {
          expect(envText.includes(secret)).toBe(false);
        }
      });

      it('the rendered configuration lives in tmpfs, mode 600, owned by the sidecar user', () => {
        const mounts = ok(
          compose('', 'exec', '-T', 'litellm', 'sh', '-c', 'grep " /run/litellm " /proc/mounts'),
          'mounts',
        ).stdout;
        expect(mounts).toMatch(/^tmpfs \/run\/litellm tmpfs ro/m);
        const stat = ok(
          compose(
            '',
            'exec',
            '-T',
            'litellm-agent',
            'stat',
            '-c',
            '%a %U',
            '/run/litellm/config.yaml',
          ),
          'stat',
        ).stdout.trim();
        expect(stat).toBe('600 openbao');
        // The salt key is part of the rendered file (environment_variables), never an env value.
        const count = ok(
          compose(
            '',
            'exec',
            '-T',
            'litellm-agent',
            'grep',
            '-c',
            'LITELLM_SALT_KEY:',
            '/run/litellm/config.yaml',
          ),
          'grep salt',
        ).stdout.trim();
        expect(count).toBe('1');
      });

      it('the litellm policy reads provider keys and the master key, nothing else', () => {
        const token = keep(admin('bao token create -policy=litellm -ttl=5m -field=token'));
        const as = (cmd: string) =>
          compose(
            `${token}\n`,
            'exec',
            '-T',
            'openbao',
            'sh',
            '-c',
            `IFS= read -r t; BAO_TOKEN="$t" ${cmd} >/dev/null`,
          );
        expect(as('bao kv get -mount=kv litellm/providers/stub').status).toBe(0);
        expect(as('bao kv get -mount=kv cost-controller/litellm-master-key').status).toBe(0);
        expect(as('bao kv put -mount=kv litellm/providers/stub api_key=x').status).not.toBe(0);
        expect(as('bao kv get -mount=kv worker/x').status).not.toBe(0);
        expect(as('bao write -f auth/approle/role/litellm/secret-id').status).not.toBe(0);
      });

      it('addition 1: admin and info endpoints never return a provider, master or salt key', async () => {
        const s = await seed();
        const issued = await issue(s);
        const paths = [
          '/model/info',
          '/v1/model/info',
          '/v2/model/info',
          '/model_group/info',
          '/v1/models',
          '/models',
          '/health/readiness',
          '/health/liveliness',
          `/key/info?key=${issued.key.keyId}`,
          '/key/list?return_full_object=true',
          `/team/info?team_id=sdlc-tenant-${s.slug}`,
          '/team/list',
          '/get/config/callbacks',
          '/config/yaml',
          '/spend/logs/v2?start_date=2026-01-01%2000:00:00&end_date=2099-01-01%2000:00:00&page=1&page_size=100',
        ];
        let reachable = 0;
        for (const p of paths) {
          const { status, text } = await adminGet(p);
          if (status === 200) reachable += 1;
          for (const secret of [providerKey, masterKey, saltKey]) {
            expect(text.includes(secret), `${p} (HTTP ${status}) returns a key`).toBe(false);
          }
        }
        expect(reachable).toBeGreaterThanOrEqual(10);
      });
    });

    describe('AC2: one virtual key per run, with caps and the seven labels', () => {
      it('LiteLLM stores the cap, models, team and labels; every call carries the labels', async () => {
        const s = await seed();
        const issued = await issue(s);
        const info = JSON.parse((await adminGet(`/key/info?key=${issued.key.keyId}`)).text) as {
          info: {
            max_budget: number;
            models: string[];
            team_id: string;
            key_alias: string;
            metadata: Record<string, unknown>;
          };
        };
        expect(info.info.max_budget).toBe(2);
        expect(info.info.models).toEqual([MODEL]);
        expect(info.info.team_id).toBe(`sdlc-tenant-${s.slug}`);
        expect(info.info.key_alias).toBe(`run-${s.runId}`);
        for (const name of COST_LABEL_NAMES)
          expect(info.info.metadata[name]).toBe(issued.labels[name]);

        expect(await chat(issued.key.key.reveal())).toBe(200);
        const [row] = await syncUntil(s, s.runId, 1);
        expect(row).toMatchObject({
          project_id: s.projectId,
          intent_id: s.intentId,
          run_id: s.runId,
          gate: 'G4',
          agent: 'coder-openhands',
          model: MODEL,
          provider_type: 'api',
          input_tokens: '1000',
          output_tokens: '100',
          cached_input_tokens: '200',
        });
      });

      it('a model outside the key list is refused', async () => {
        const s = await seed();
        const issued = await issue(s);
        expect(await chat(issued.key.key.reveal(), 'claude-haiku-4-5')).not.toBe(200);
      });

      it('the tenant team has the monthly budget, reset each UTC calendar month', async () => {
        const s = await seed({ monthly: '100' });
        await issue(s);
        const team = JSON.parse(
          (await adminGet(`/team/info?team_id=sdlc-tenant-${s.slug}`)).text,
        ) as {
          team_info: { max_budget: number; budget_duration: string; budget_reset_at: string };
        };
        expect(team.team_info.max_budget).toBe(100);
        expect(team.team_info.budget_duration).toBe('1mo');
        const reset = new Date(team.team_info.budget_reset_at);
        expect([reset.getUTCDate(), reset.getUTCHours(), reset.getUTCMinutes()]).toEqual([1, 0, 0]);
      });
    });

    describe('AC3: revoke at the end of the run', () => {
      it('endRun revokes the key: the next call is refused with 401', async () => {
        const s = await seed();
        const issued = await issue(s);
        expect(await chat(issued.key.key.reveal())).toBe(200);
        await controller.endRun({ keyId: issued.key.keyId, syncFrom: now });
        expect(await chat(issued.key.key.reveal())).toBe(401);
      });

      it('C06: endRunKey revokes the key by its run (alias), without the key ID', async () => {
        const s = await seed();
        const issued = await issue(s);
        expect(await chat(issued.key.key.reveal())).toBe(200);
        await controller.endRunKey({ runId: s.runId, syncFrom: now });
        expect(await chat(issued.key.key.reveal())).toBe(401);
      });

      it('C06 (Harry, session 2 plan): the key ID (the hash) is not a key', async () => {
        const s = await seed();
        const issued = await issue(s);
        expect(issued.key.keyId).toMatch(/^[0-9a-f]{64}$/);
        // LiteLLM treats a key that does not start with sk- as already hashed in some versions;
        // the pinned version must refuse it, so the ID may appear in logs without being a key.
        expect(await chat(issued.key.keyId)).toBe(401);
        expect(await chat(`sk-${issued.key.keyId}`)).toBe(401);
      });
    });

    describe('C07: the runner reads the spend of a run with the run key itself (ADR-M34 §2.6)', () => {
      /** A call with a run key as the bearer; returns the status and the raw body text. */
      async function asRunKey(key: string, pathAndQuery: string) {
        const response = await fetch(`${litellmUrl}${pathAndQuery}`, {
          headers: { authorization: `Bearer ${key}` },
        });
        return { status: response.status, text: await response.text() };
      }

      it('reads its own spend and cap; never the info of another key', async () => {
        const own = await seed();
        const other = await seed();
        const ownKey = await issue(own);
        const otherKey = await issue(other);
        const reader = new LiteLLMKeySpendReader({ baseUrl: litellmUrl });

        expect(await chat(ownKey.key.key.reveal())).toBe(200);
        let info = await reader.readOwnSpend(ownKey.key.key);
        for (let i = 0; i < 30 && info.spendUsd === '0'; i++) {
          await sleep(1000); // LiteLLM records spend in batches
          info = await reader.readOwnSpend(ownKey.key.key);
        }
        expect(info).toEqual({ spendUsd: String(COST_PER_CALL), maxBudgetUsd: '2' });

        // Asking about the other key, by its hash or by the key itself, with the run key: LiteLLM
        // refuses, or answers only about the calling key. Never about the other one.
        const otherAlias = `run-${other.runId}`;
        const leaking: string[] = [];
        for (const [name, query] of [
          ['info_by_hash', `/key/info?key=${otherKey.key.keyId}`],
          ['info_by_key', `/key/info?key=${otherKey.key.key.reveal()}`],
          ['list_full', '/key/list?return_full_object=true'],
          ['list_by_alias', `/key/list?key_alias=${otherAlias}`],
        ] as const) {
          const { status, text } = await asRunKey(ownKey.key.key.reveal(), query);
          const found = [
            text.includes(otherKey.key.keyId) ? 'hash' : '',
            text.includes(otherAlias) ? 'alias' : '',
            text.includes(otherKey.key.key.reveal()) ? 'key' : '',
            text.includes(other.slug) ? 'tenant' : '',
          ].filter(Boolean);
          if (found.length > 0) leaking.push(`${name}:${String(status)}:${found.join('+')}`);
        }
        expect(leaking).toEqual([]);

        // A revoked key reads nothing.
        await controller.endRunKey({ runId: own.runId, syncFrom: now });
        await expect(reader.readOwnSpend(ownKey.key.key)).rejects.toMatchObject({
          code: 'http_error',
        });
      });

      it('a key over its cap still reads its own spend, within the re-read wait (the runner sees the budget stop)', async () => {
        const s = await seed({ runBudget: '0.002' });
        const issued = await issue(s);
        const statuses = await callUntilBlocked(issued.key.key.reveal(), 8);
        expect(statuses.at(-1)).toBe(429);
        const reader = new LiteLLMKeySpendReader({ baseUrl: litellmUrl });
        const blockedAt = Date.now();
        let info = await reader.readOwnSpend(issued.key.key);
        while (Number(info.spendUsd) < 0.002 && Date.now() - blockedAt < 90_000) {
          await sleep(1000);
          info = await reader.readOwnSpend(issued.key.key);
        }
        process.stderr.write(
          `C07 over-cap read after ${String(Date.now() - blockedAt)} ms: ${JSON.stringify(info)}\n`,
        );
        expect(Number(info.spendUsd)).toBeGreaterThanOrEqual(0.002);
        // LiteLLM blocks at once but writes the spend /key/info shows in batches (10 s by
        // default): the runner's re-read wait (SDLC_RUNNER_AGENT_SPEND_RECHECK_SECONDS, 25 s by
        // default) must be longer than this lag (ADR-M34 §2.6).
        expect(Date.now() - blockedAt).toBeLessThan(25_000);
      });
    });

    describe('AC4: spend sync', () => {
      it('two calls give two records; syncing again adds nothing', async () => {
        const s = await seed();
        const issued = await issue(s);
        expect(await chat(issued.key.key.reveal())).toBe(200);
        expect(await chat(issued.key.key.reveal())).toBe(200);
        const rows = await syncUntil(s, s.runId, 2);
        expect(rows).toHaveLength(2);
        const again = await controller.syncSpend({
          from: new Date(now.getTime() - 60_000),
          to: new Date(Date.now() + 60_000),
        });
        expect(again.inserted).toBe(0);
        expect(await s.scope.costRecords.listForRun(s.runId)).toHaveLength(2);
        expect(await s.scope.costRecords.totalForIntent(s.intentId)).toBe('0.002000');
      });
    });

    describe('AC5 / FR-51: over budget, the request is blocked', () => {
      it('run level: the key budget blocks the next call (at most one call over, QUESTIONS #14)', async () => {
        const s = await seed({ runBudget: '0.003' });
        const issued = await issue(s);
        const statuses = await callUntilBlocked(issued.key.key.reveal(), 8);
        expect(statuses.at(-1)).toBe(429);
        const allowed = statuses.filter((x) => x === 200).length;
        expect(allowed).toBeGreaterThanOrEqual(Math.floor(0.003 / COST_PER_CALL));
        expect(allowed).toBeLessThanOrEqual(Math.ceil(0.003 / COST_PER_CALL) + 1);
      });

      it('intent level: the key is capped at what is left, and refused when nothing is left', async () => {
        const s = await seed({ intentBudget: '0.004', runBudget: '1' });
        const first = await issue(s);
        expect([first.maxBudgetUsd, first.limitedBy]).toEqual(['0.004', 'intent']);
        await callUntilBlocked(first.key.key.reveal(), 10);
        await syncUntil(s, s.runId, 4);
        const next = await issueRun(s.scope, s, { runBudget: '1', models: [MODEL], now });
        await expect(issue(s, next)).rejects.toMatchObject({ code: 'intent_budget_exhausted' });
        await expect(issue(s, next)).rejects.toBeInstanceOf(CostError);
      });

      it('tenant level: the team budget blocks every key of the tenant', async () => {
        const s = await seed({ monthly: '0.002', intentBudget: '10', runBudget: '1' });
        const first = await issue(s);
        expect(first.limitedBy).toBe('tenant');
        await callUntilBlocked(first.key.key.reveal(), 8);
        // A second key of the same tenant, with its own large budget: the team budget still blocks.
        const runId = crypto.randomUUID();
        const second = await gateway.createRunKey({
          runId,
          labels: { ...first.labels, run_id: runId },
          maxBudgetUsd: '1',
          models: [MODEL],
          durationMinutes: 10,
          tenantGroupId: `sdlc-tenant-${s.slug}`,
        });
        expect(await chat(second.key.reveal())).toBe(429);
      });
    });
  },
);
