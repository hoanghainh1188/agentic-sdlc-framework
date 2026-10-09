// D-08 V02 AC5: `pnpm trial:up` from an empty checkout to a project ready for T01, then the first
// intent at G1 by Person A from their own credentials file, then `pnpm trial:down --wipe`. Needs
// Docker. Skipped unless SDLC_TRIAL_UP_TEST=1. Run with: pnpm test:trial-up (CI: the job
// fresh-deploy, weekly and on demand only).
//
// The real program (`platform/deploy/trial/dist/main.js`) runs as a child process on a throw-away
// Compose project (its own name, subnet and ports +33000; the test-only overrides SDLC_TRIAL_*).
// Throw-away inputs: an RSA key as the GitHub App key (the worker's polls of GitHub fail and are
// logged; the first intent needs no GitHub call), a random Anthropic key (no model call is made),
// fake GitHub IDs, a local Git repository as the fork's clone. The test checks the program's whole
// output for anything that looks like a secret (AC3) and the credentials files' modes.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { processContext, runCli, type CliContext } from '../../../apps/cli/src/index.js';
import { repoRoot } from '../../workspace/helpers';

const enabled = process.env.SDLC_TRIAL_UP_TEST === '1';
const PORT_OFFSET = 33000;
const SETUP_TIMEOUT_MS = 45 * 60 * 1000;

interface Result {
  status: number | null;
  output: string;
}

describe.skipIf(!enabled)(
  'V02: pnpm trial:up to the first intent at G1, then trial:down --wipe (live)',
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-trial-it-'));
    const main = path.join(repoRoot(), 'platform/deploy/trial/dist/main.js');
    const project = `sdlctrialit${process.pid}`;
    const subnet = `172.29.${40 + (process.pid % 10)}.0/24`;
    const envFile = path.join(tmp, 'trial.env');
    const settingsFile = path.join(tmp, 'trial-settings.yaml');
    const configA = path.join(tmp, 'config-a');
    const configB = path.join(tmp, 'config-b');
    const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs1',
      format: 'pem',
    }) as string;
    const modelKey = `sk-ant-${randomBytes(24).toString('hex')}`;
    const env = {
      ...process.env,
      SDLC_TRIAL_ENV_FILE: envFile,
      SDLC_TRIAL_PROJECT: project,
      SDLC_TRIAL_SUBNET: subnet,
      SDLC_TRIAL_GATEWAY: subnet.replace(/0\/24$/, '1'),
      SDLC_TRIAL_PORT_OFFSET: String(PORT_OFFSET),
    };
    let up: Result = { status: null, output: '' };

    /** The program, like a tester runs it; the whole output is kept for the secret check. */
    const program = (args: string[]): Promise<Result> =>
      new Promise((resolve) => {
        const child = spawn('node', [main, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (d: Buffer) => chunks.push(d));
        child.stderr.on('data', (d: Buffer) => chunks.push(d));
        child.on('close', (status) =>
          resolve({ status, output: Buffer.concat(chunks).toString('utf8') }),
        );
      });

    /** `sdlc …` as a person: the saved login of their config folder, nothing else. */
    async function sdlc(
      configHome: string,
      argv: readonly string[],
    ): Promise<Record<string, unknown>> {
      const out: string[] = [];
      const err: string[] = [];
      const ctx: CliContext = {
        ...processContext(),
        env: { HOME: tmp, XDG_CONFIG_HOME: configHome },
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      };
      const code = await runCli([...argv, '--json'], ctx);
      if (code !== 0) throw new Error(`sdlc ${argv.slice(0, 2).join(' ')} → ${String(code)}`);
      return JSON.parse(out.join('\n')) as Record<string, unknown>;
    }

    beforeAll(async () => {
      fs.writeFileSync(path.join(tmp, 'app.pem'), appKey, { mode: 0o600 });
      fs.writeFileSync(path.join(tmp, 'model.key'), modelKey, { mode: 0o600 });
      const clone = path.join(tmp, 'fork');
      fs.mkdirSync(clone);
      const git = (...args: string[]) =>
        spawnSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args]);
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(
        path.join(clone, 'AGENTS.md'),
        '# Agent instructions\n\n- Keep changes small.\n',
      );
      git('add', 'AGENTS.md');
      git('commit', '-q', '-m', 'init');
      fs.writeFileSync(
        settingsFile,
        [
          'fork:',
          '  repo: trial-tester/pilot-order-inventory',
          `  clone: ${clone}`,
          'github_app:',
          '  client_id: Iv23trial0up0test',
          `  private_key_file: ${path.join(tmp, 'app.pem')}`,
          'model:',
          '  provider: anthropic',
          `  api_key_file: ${path.join(tmp, 'model.key')}`,
          'people:',
          `  person_a: { email: a@trial.test, name: Person A, github_id: 7101, github_login: trial-a, config_home: ${configA} }`,
          `  person_b: { email: b@trial.test, name: Person B, github_id: 7102, github_login: trial-b, config_home: ${configB} }`,
          '',
        ].join('\n'),
      );
      up = await program(['up', '--settings', settingsFile]);
      if (up.status !== 0) throw new Error(`trial:up failed:\n${up.output.slice(-6000)}`);
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
      if (process.env.SDLC_TRIAL_UP_KEEP === '1') return;
      await program(['down', '--wipe', '--yes', '--settings', settingsFile]);
      fs.rmSync(tmp, { recursive: true, force: true });
    }, 300_000);

    it('AC1: every step ran; the program says the stack is throw-away and ready', () => {
      for (let n = 2; n <= 13; n += 1) expect(up.output).toContain(`Step ${n} of 13`);
      expect(up.output).toContain('THROW-AWAY keys');
      expect(up.output).toContain('The trial stack is ready');
    });

    it('AC3: no secret in the output; logins only in their own files, mode 600', () => {
      expect(up.output).not.toMatch(/sdlc_pat_|hvs\.|Initial Root Token: \S|Unseal Key \d+: \S/);
      expect(up.output).not.toContain(modelKey);
      expect(up.output).not.toContain('PRIVATE KEY');
      for (const dir of [configA, configB]) {
        const file = path.join(dir, 'sdlc', 'credentials.json');
        expect(fs.statSync(file).mode & 0o777, file).toBe(0o600);
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      }
      // The env file holds no OpenBao key share or token (only the generated passwords).
      expect(fs.readFileSync(envFile, 'utf8')).not.toMatch(/hvs\.|Unseal/);
    });

    it('AC1: Person A and Person B are logged in with their roles; the project is configured', async () => {
      const a = await sdlc(configA, ['whoami']);
      const b = await sdlc(configB, ['whoami']);
      expect(JSON.stringify(a)).toContain('person_a');
      expect(JSON.stringify(b)).toContain('person_b');
      expect(await sdlc(configA, ['admin', 'agent', 'show', '--key', 'trial-coder'])).toMatchObject(
        {
          status: 'active',
          model_ref: 'claude-haiku-4-5-20251001',
        },
      );
      const config = await sdlc(configA, ['admin', 'config', 'show', '--project', 'pilot']);
      expect(JSON.stringify(config)).toContain('working_hours');
      expect(JSON.stringify(config)).toContain('ci-ok');
    });

    it('AC5: Person A creates the first intent; the worker moves it to G1', async () => {
      const created = await sdlc(configA, [
        'intent',
        'create',
        '--project',
        'pilot',
        '--title',
        'First trial intent',
        '--risk',
        'low',
        '--data-class',
        'internal',
      ]);
      const code = String(created.code);
      expect(code).toMatch(/^INT-\d{4}-0001$/);
      const deadline = Date.now() + 120_000;
      let shown: Record<string, unknown>;
      for (;;) {
        shown = await sdlc(configA, ['intent', 'show', code]);
        if (shown.current_gate === 'G1' || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      expect(shown).toMatchObject({ status: 'in_gate', current_gate: 'G1' });
      expect(await sdlc(configA, ['audit', 'verify'])).toMatchObject({ ok: true, broken: null });
    });

    it('AC2: a second trial:up refuses the existing stack and touches nothing', async () => {
      const again = await program(['up', '--settings', settingsFile]);
      expect(again.status).toBe(1);
      expect(again.output).toContain('Refused:');
      expect(again.output).not.toContain('Step 2 of 13');
    });

    it('AC4: trial:down --wipe without a confirmation removes nothing', async () => {
      const refused = await program(['down', '--wipe']);
      expect(refused.status).toBe(1);
      expect(fs.existsSync(envFile)).toBe(true);
    });
  },
  SETUP_TIMEOUT_MS,
);
