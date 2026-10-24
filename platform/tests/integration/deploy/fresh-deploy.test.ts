// D-08 E07 AC3: follows `platform/deploy/README.md`, section "Fresh deployment (operator)", step by
// step, on a throw-away Compose project: from an empty env file to the first intent at G1, with
// every profile the server runs (`core models platform sandbox`). Needs Docker. Skipped unless
// SDLC_FRESH_DEPLOY_TEST=1. Run with: pnpm test:fresh-deploy (CI: the weekly run and manual
// dispatch only). The static test `platform/tests/deploy/fresh-deploy-readme.test.ts` keeps the
// README and this test in step: every credentials command the README names runs here.
//
// Own Compose project (own name, subnet, ports +31000, random env file), removed afterwards. The
// steps and what differs from a real deployment: `deploy-steps.ts` (shared with `pnpm
// test:upgrade`, O02). The sandbox image: SDLC_SANDBOX_IMAGE when set, else `build.sh node24`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { repoRoot } from '../../workspace/helpers';
import { CREDENTIALS_COMMANDS, Deployment } from './deploy-steps';

const enabled = process.env.SDLC_FRESH_DEPLOY_TEST === '1';
const PORT_OFFSET = 31000;
const SETUP_TIMEOUT_MS = 30 * 60 * 1000;

describe.skipIf(!enabled)(
  'E07 AC3: a fresh deployment following the README (live)',
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-fresh-'));
    const subnet = `172.29.${20 + (process.pid % 10)}.0/24`;
    const d = new Deployment({
      root: repoRoot(),
      tmp,
      envFile: path.join(tmp, 'it.env'),
      project: {
        project: `sdlcfresh${process.pid}`,
        subnet,
        gateway: subnet.replace(/0\/24$/, '1'),
        portOffset: PORT_OFFSET,
      },
    });
    const litellmUrl = `http://127.0.0.1:${4000 + PORT_OFFSET}`;
    const timings: Record<string, number> = {};
    const started = Date.now();
    const mark = (step: string) => {
      timings[step] = Math.round((Date.now() - started) / 1000);
    };

    beforeAll(() => {
      d.settingsFile(); // step 2
      mark('env');
      // Step 3: OpenBao, PostgreSQL and SeaweedFS only (the whole `core` cannot be healthy before
      // step 7: LiteLLM has no keys in .env on the server).
      d.startStores();
      d.initOpenBao();
      mark('openbao');
      d.sharedSecrets(); // step 4
      mark('secrets');
      for (const command of CREDENTIALS_COMMANDS) d.credentials(command); // step 5
      mark('credentials');
      d.migrate(); // step 6
      mark('migrate');
      d.up(); // step 7
      mark('up');
      d.tenant(); // step 8
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      process.stdout.write(`e07:fresh_deploy_seconds:${JSON.stringify(timings)}\n`);
      if (process.env.SDLC_FRESH_DEPLOY_KEEP === '1') return;
      d.down();
      fs.rmSync(tmp, { recursive: true, force: true });
    }, 300_000);

    it('step 7: every long-running service of core, models, platform and sandbox is healthy', async () => {
      const lines = d.services();
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
      expect((await fetch(`${d.apiUrl}/health/ready`)).status).toBe(200);
      // LiteLLM runs with the configuration the sidecar rendered from OpenBao: the API model's
      // gateway name carries its version (QUESTIONS #93).
      const models = d.run('docker', [
        'exec',
        `${d.options.project.project}-litellm-1`,
        'sh',
        '-c',
        'grep -c "model_name: claude-haiku-4-5-20251001" /run/litellm/config.yaml',
      ]);
      expect(models.stdout.trim()).toBe('1');
      expect(litellmUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    });

    it('steps 8–14: tenant, team, sandbox image, agent, configuration, AI record, first intent at G1', async () => {
      d.team(); // step 9
      mark('team');
      const image = process.env.SDLC_SANDBOX_IMAGE ?? d.buildSandboxImage(); // step 10
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
      mark('image');
      d.agentConfigAndRecord(image); // steps 11–13
      expect(d.sdlc('admin', ['admin', 'agent', 'show', '--key', 'coder'])).toMatchObject({
        status: 'active',
      });

      // Step 14: the first intent; the worker's workflow moves it into G1.
      const code = d.createIntent('First intent');
      expect(code).toMatch(/^INT-\d{4}-0001$/);
      expect(await d.waitForGate(code, 'G1')).toMatchObject({
        status: 'in_gate',
        current_gate: 'G1',
      });
      mark('first_intent');

      // The audit chain of the new tenant is intact (FR-41).
      expect(d.sdlc('admin', ['audit', 'verify'])).toMatchObject({ ok: true, broken: null });
    });
  },
  SETUP_TIMEOUT_MS,
);
