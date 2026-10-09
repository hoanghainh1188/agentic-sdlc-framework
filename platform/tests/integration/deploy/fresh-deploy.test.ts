// D-08 E07 AC3: follows `platform/deploy/README.md`, section "Fresh deployment (operator)", step by
// step, on a throw-away Compose project: from an empty env file to the first intent at G1, with
// every profile the server runs (`core models platform sandbox`). Needs Docker. Skipped unless
// SDLC_FRESH_DEPLOY_TEST=1. Run with: pnpm test:fresh-deploy (CI: the weekly run and manual
// dispatch only). The static test `platform/tests/deploy/fresh-deploy-readme.test.ts` keeps the
// README and this test in step: every credentials command the README names runs here.
//
// Own Compose project (own name, subnet, ports +31000, random env file), removed afterwards. Key
// shares, tokens, passwords and keys are THROW-AWAY TEST VALUES: kept in variables, never printed,
// never in an assertion message. What differs from a real deployment, and why:
// - `init --stdout-not-tty` and stdin instead of hidden prompts (the bootstrap's test switch);
// - the GitHub App key is a throw-away RSA key: the worker's polls of GitHub fail and are logged,
//   which does not stop the platform; the first intent needs no GitHub call;
// - the model provider key is a throw-away value: LiteLLM serves the Anthropic entry of
//   `config.ctmpl` (rendered from OpenBao), and no model call is made;
// - the sandbox image: SDLC_SANDBOX_IMAGE when set, else `build.sh node24` (`--no-push` on Docker
//   Desktop, which cannot push to a port published on the host; README step 10).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { processContext, runCli, type CliContext } from '../../../apps/cli/src/index.js';
import { deployDir, parseEnvFile } from '../../deploy/compose';
import { repoRoot } from '../../workspace/helpers';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_FRESH_DEPLOY_TEST === '1';
const PORT_OFFSET = 31000;
const SETUP_TIMEOUT_MS = 30 * 60 * 1000;
const PROFILES = ['core', 'models', 'platform', 'sandbox'] as const;
/** README step 5, in its order. */
const CREDENTIALS_COMMANDS = [
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
const MODEL = 'claude-haiku-4-5-20251001';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!enabled)(
  'E07 AC3: a fresh deployment following the README (live)',
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-fresh-'));
    const envFile = path.join(tmp, 'it.env');
    const project = `sdlcfresh${process.pid}`;
    const subnet = `172.29.${20 + (process.pid % 10)}.0/24`;
    const gatewayIp = subnet.replace(/0\/24$/, '1');
    const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');
    const apiUrl = `http://127.0.0.1:${8090 + PORT_OFFSET}`;
    const litellmUrl = `http://127.0.0.1:${4000 + PORT_OFFSET}`;
    const composeArgs = PROFILES.flatMap((p) => ['--profile', p]);

    const secrets: string[] = [];
    const keep = (value: string): string => {
      if (value) secrets.push(value);
      return value;
    };
    const redact = (text: string): string =>
      secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);
    let rootToken = '';
    let appUrl = '';
    const tokens: Record<'admin' | 'a' | 'b', string> = { admin: '', a: '', b: '' };
    let intentCode = '';
    const timings: Record<string, number> = {};
    const started = Date.now();
    const mark = (step: string) => {
      timings[step] = Math.round((Date.now() - started) / 1000);
    };

    const run = (cmd: string, args: string[], input = '', env: NodeJS.ProcessEnv = {}): Result => {
      const r = spawnSync(cmd, args, {
        encoding: 'utf8',
        input,
        env: { ...process.env, SDLC_ENV_FILE: envFile, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const ok = (r: Result, what: string): Result => {
      if (r.status !== 0) {
        throw new Error(
          `${what} failed (exit ${r.status}): ${redact(r.stderr + r.stdout).slice(-4000)}`,
        );
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
    /** An admin command in the OpenBao container; the root token and the values come on stdin. */
    const admin = (script: string, input: string): void => {
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
      );
    };

    /** `sdlc …` like a person: the API with a token (`SDLC_API_URL` + `SDLC_API_TOKEN`). */
    async function sdlc(
      who: 'admin' | 'a' | 'b' | 'operator',
      argv: readonly string[],
    ): Promise<Record<string, unknown>> {
      const out: string[] = [];
      const err: string[] = [];
      const env: Record<string, string> = { HOME: tmp };
      if (who === 'operator') env.SDLC_DB_URL = appUrl;
      else {
        env.SDLC_API_URL = apiUrl;
        env.SDLC_API_TOKEN = tokens[who];
      }
      const ctx: CliContext = {
        env,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        connect: processContext().connect,
      };
      const code = await runCli([...argv, '--json'], ctx);
      if (code !== 0) {
        throw new Error(
          `sdlc ${argv.slice(0, 3).join(' ')} → ${String(code)}: ${redact(err.join('\n'))}`,
        );
      }
      return JSON.parse(out.join('\n')) as Record<string, unknown>;
    }

    beforeAll(async () => {
      // README step 2: the settings file (server mode: no LiteLLM keys in .env).
      ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'compose:env');
      const text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
        project,
        subnet,
        gateway: gatewayIp,
        portOffset: PORT_OFFSET,
      })
        .replace(/^LITELLM_MASTER_KEY=.*$/m, 'LITELLM_MASTER_KEY=')
        .replace(/^LITELLM_SALT_KEY=.*$/m, 'LITELLM_SALT_KEY=');
      fs.writeFileSync(envFile, text, { mode: 0o600 });
      const env = parseEnvFile(text);
      keep(env.get('PLATFORM_APP_DB_PASSWORD')!);
      keep(env.get('PLATFORM_DB_PASSWORD')!);
      mark('env');

      // Step 3: OpenBao, PostgreSQL and SeaweedFS only (the whole `core` cannot be healthy before
      // step 7: LiteLLM has no keys in .env on the server).
      ok(
        compose('', '--profile', 'core', 'up', '-d', '--wait', 'openbao', 'postgres', 'seaweedfs'),
        'openbao, postgres and seaweedfs',
      );
      const init = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
      const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
      ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
      ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');
      mark('openbao');

      // Step 4: the shared secrets (throw-away values; read from stdin, never on a command line).
      const pem = keep(
        generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
          type: 'pkcs1',
          format: 'pem',
        }) as string,
      );
      admin(
        'IFS= read -r CLIENT_ID; bao kv put -mount=kv shared/github-app client_id="$CLIENT_ID" private_key=- >/dev/null',
        `Iv23fresh0deploy0test\n${pem}`,
      );
      const random = () => keep(`sk-${randomBytes(24).toString('hex')}`);
      admin(
        'IFS= read -r m; IFS= read -r s; IFS= read -r p; ' +
          'printf %s "$m" | bao kv put -mount=kv cost-controller/litellm-master-key value=- >/dev/null && ' +
          'printf %s "$s" | bao kv put -mount=kv litellm/salt-key value=- >/dev/null && ' +
          'printf %s "$p" | bao kv put -mount=kv litellm/providers/anthropic api_key=- >/dev/null',
        `${random()}\n${random()}\n${random()}\n`,
      );
      mark('secrets');

      // Step 5: the credentials of every process.
      for (const command of CREDENTIALS_COMMANDS) {
        ok(bootstrapCmd([command], `${rootToken}\n`), command);
      }
      mark('credentials');

      // Step 6: the database.
      const pgUrl = (user: string, password: string) =>
        `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${5432 + PORT_OFFSET}/platform`;
      ok(
        run(
          'node',
          [path.join(repoRoot(), 'platform/packages/core/dist/db/migrate-cli.js'), 'latest'],
          '',
          {
            SDLC_DB_MIGRATION_URL: pgUrl('platform', env.get('PLATFORM_DB_PASSWORD')!),
          },
        ),
        'db:migrate',
      );
      appUrl = keep(pgUrl('platform_app', env.get('PLATFORM_APP_DB_PASSWORD')!));
      mark('migrate');

      // Step 7: the platform (every profile of the server).
      const up = run(path.join(deployDir, 'scripts/up.sh'), [...PROFILES], '', {
        SDLC_WAIT_TIMEOUT: '900',
      });
      if (up.status !== 0) {
        const logs = compose('', ...composeArgs, 'logs', '--no-color', '--tail', '80');
        throw new Error(`up.sh failed: ${redact(up.stderr + logs.stdout).slice(-6000)}`);
      }
      mark('up');

      // Step 8: the tenant and its first admin (the token is printed once).
      const boot = await sdlc('operator', [
        'ops',
        'bootstrap',
        '--tenant',
        'fresh',
        '--tenant-name',
        'Fresh',
        '--email',
        'admin@fresh.test',
        '--name',
        'Admin',
      ]);
      tokens.admin = keep(String(boot.token));
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      process.stdout.write(`e07:fresh_deploy_seconds:${JSON.stringify(timings)}\n`);
      if (process.env.SDLC_FRESH_DEPLOY_KEEP === '1') return;
      compose(
        '',
        ...composeArgs,
        '--profile',
        'observability',
        // A10: the backup job's AppRole volume belongs to the profile `backup` only.
        '--profile',
        'backup',
        'down',
        '--volumes',
        '--remove-orphans',
      );
      fs.rmSync(tmp, { recursive: true, force: true });
    }, 300_000);

    it('step 7: every long-running service of core, models, platform and sandbox is healthy', async () => {
      const ps = ok(
        compose('', ...composeArgs, 'ps', '--format', '{{.Service}} {{.State}} {{.Health}}'),
        'ps',
      );
      const lines = ps.stdout.split('\n').filter((l) => l.trim() !== '');
      for (const service of [
        'openbao',
        'postgres',
        'temporal',
        'litellm-agent',
        'litellm',
        'sdlc-api',
        'sdlc-worker',
        'sdlc-runner',
        'seaweedfs',
      ]) {
        expect(
          lines.find((l) => l.startsWith(`${service} `)),
          service,
        ).toMatch(/ running (healthy)?$/);
      }
      expect((await fetch(`${apiUrl}/health/ready`)).status).toBe(200);
      // LiteLLM runs with the configuration the sidecar rendered from OpenBao: the API model's
      // gateway name carries its version (QUESTIONS #93).
      const models = run('docker', [
        'exec',
        `${project}-litellm-1`,
        'sh',
        '-c',
        'grep -c "model_name: claude-haiku-4-5-20251001" /run/litellm/config.yaml',
      ]);
      expect(models.stdout.trim()).toBe('1');
      expect(litellmUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    });

    it('steps 8–14: tenant, team, sandbox image, agent, configuration, AI record, first intent at G1', async () => {
      // Step 9: the project and its team (Person A and Person B, each with a token).
      await sdlc('admin', [
        'admin',
        'project',
        'create',
        '--slug',
        'pilot',
        '--name',
        'Pilot',
        '--repo',
        'acme/fresh-deploy',
      ]);
      const people = [
        {
          who: 'a' as const,
          email: 'a@fresh.test',
          gh: '7001',
          login: 'fresh-a',
          role: 'person_a',
        },
        {
          who: 'b' as const,
          email: 'b@fresh.test',
          gh: '7002',
          login: 'fresh-b',
          role: 'person_b',
        },
      ];
      for (const p of people) {
        await sdlc('admin', ['admin', 'user', 'create', '--email', p.email, '--name', p.who]);
        await sdlc('admin', [
          'admin',
          'identity',
          'link',
          '--user',
          p.email,
          '--github-id',
          p.gh,
          '--github-login',
          p.login,
        ]);
        await sdlc('admin', [
          'admin',
          'role',
          'grant',
          '--project',
          'pilot',
          '--user',
          p.email,
          '--role',
          p.role,
        ]);
        const issued = await sdlc('admin', [
          'admin',
          'token',
          'issue',
          '--user',
          p.email,
          '--name',
          `${p.who}-laptop`,
        ]);
        tokens[p.who] = keep(String(issued.token));
      }
      mark('team');

      // Step 10: the sandbox image, by digest.
      let image = process.env.SDLC_SANDBOX_IMAGE ?? '';
      if (!image) {
        const desktop = /Docker Desktop/i.test(
          run('docker', ['info', '--format', '{{.OperatingSystem}}']).stdout,
        );
        const built = ok(
          run(
            path.join(repoRoot(), 'platform/sandbox-images/build.sh'),
            ['node24', ...(desktop ? ['--no-push'] : [])],
            '',
            {
              SDLC_SANDBOX_REGISTRY: `localhost:${5050 + PORT_OFFSET}`,
            },
          ),
          'sandbox-image:build',
        );
        image = built.stdout.trim().split('\n').pop() ?? '';
      }
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
      mark('image');

      // Step 11: the agent, registered by the tenant admin and approved by its owner and Person B.
      const agentsMd = path.join(tmp, 'AGENTS.md');
      fs.writeFileSync(agentsMd, '# Agent instructions\n\n- Keep changes small.\n');
      await sdlc('admin', [
        'admin',
        'agent',
        'register',
        '--key',
        'coder',
        '--version',
        '1.0.0',
        '--owner',
        'a@fresh.test',
        '--model',
        MODEL,
        '--instructions',
        'AGENTS.md@v1',
        '--instructions-file',
        agentsMd,
        '--tools',
        'file_editor,terminal',
        '--max-autonomy',
        'L2',
        '--environments',
        'sandbox',
      ]);
      await sdlc('a', [
        'admin',
        'agent',
        'approve',
        '--key',
        'coder',
        '--purpose',
        'activate',
        '--as',
        'owner',
      ]);
      await sdlc('b', [
        'admin',
        'agent',
        'approve',
        '--key',
        'coder',
        '--purpose',
        'activate',
        '--as',
        'person_b',
      ]);
      expect(await sdlc('admin', ['admin', 'agent', 'show', '--key', 'coder'])).toMatchObject({
        status: 'active',
      });

      // Step 12: the project configuration.
      const shown = await sdlc('admin', ['admin', 'config', 'show', '--project', 'pilot']);
      const config = path.join(tmp, 'pilot.yaml');
      fs.writeFileSync(
        config,
        [
          'run:',
          '  agent_key: coder',
          'sandbox:',
          `  image: ${image}`,
          'verification:',
          '  required_checks: [ci-ok]',
          '',
        ].join('\n'),
      );
      await sdlc('admin', [
        'admin',
        'config',
        'set',
        '--project',
        'pilot',
        '--file',
        config,
        '--expected-version',
        String(shown.version),
      ]);

      // Step 13: the project AI record, by Person A.
      await sdlc('a', [
        'ai-record',
        'set',
        '--project',
        'pilot',
        '--expected-version',
        '0',
        '--ai-allowed',
        'yes',
        '--classes',
        'public,internal',
        '--prod-logs',
        'no',
        '--disclosure',
        'standard_note',
      ]);

      // Step 14: the first intent; the worker's workflow moves it into G1.
      const created = await sdlc('a', [
        'intent',
        'create',
        '--project',
        'pilot',
        '--title',
        'First intent',
        '--risk',
        'low',
        '--data-class',
        'internal',
      ]);
      intentCode = String(created.code);
      expect(intentCode).toMatch(/^INT-\d{4}-0001$/);
      const deadline = Date.now() + 120_000;
      let shownIntent: Record<string, unknown>;
      for (;;) {
        shownIntent = await sdlc('a', ['intent', 'show', intentCode]);
        if (shownIntent.current_gate === 'G1' || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      expect(shownIntent).toMatchObject({ status: 'in_gate', current_gate: 'G1' });
      mark('first_intent');

      // The audit chain of the new tenant is intact (FR-41).
      expect(await sdlc('admin', ['audit', 'verify'])).toMatchObject({ ok: true, broken: null });
    });
  },
  SETUP_TIMEOUT_MS,
);
