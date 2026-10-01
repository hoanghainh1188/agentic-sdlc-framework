// Live test of the AppRole credential rotation: bootstrap.sh api-credentials, worker-credentials,
// runner-credentials and litellm-credentials (ADR-M19, QUESTIONS #140). Needs Docker. Skipped
// unless SDLC_OPENBAO_TEST=1. Run with: pnpm test:openbao
//
// Each command is run twice. After the second run, the AppRole has exactly one secret ID, the
// service's new secret ID logs in from the Compose network, and the old secret ID is refused by
// the same login (QUESTIONS #140). All five AppRoles: api, worker, cost-controller, runner, litellm.
// Own throw-away Compose project (own name, ports, subnet, random env file), removed afterwards.
// Key shares, tokens, role IDs and secret IDs are THROW-AWAY TEST KEYS: kept in variables of this
// process only, never printed, never written to a file, never in an assertion message.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir } from '../../deploy/compose';
import { isolateEnv, openbaoImage } from '../throwaway-compose';

const enabled = process.env.SDLC_OPENBAO_TEST === '1';
const PORT_OFFSET = 26000;
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Credentials {
  roleId: string;
  secretId: string;
}

// Every AppRole a rotation command delivers, with the volume it writes (docker-compose.yml).
// worker-credentials rotates two AppRoles: worker and cost-controller (C06, ADR-M33 §2.5).
const ROTATIONS = [
  { role: 'api', command: 'api-credentials', volume: 'api-approle' },
  { role: 'worker', command: 'worker-credentials', volume: 'worker-approle' },
  { role: 'cost-controller', command: 'worker-credentials', volume: 'worker-cost-approle' },
  { role: 'runner', command: 'runner-credentials', volume: 'runner-approle' },
  { role: 'litellm', command: 'litellm-credentials', volume: 'litellm-approle' },
] as const;

describe.skipIf(!enabled)(
  'AppRole credential rotation (live)',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-rotation-it-'));
    const envFile = path.join(tmp, 'it.env');
    const project = `sdlcrot${process.pid}`;
    const network = `${project}-net`;
    // Subnet range of this file: 50–99 (the other live test files use 100–249).
    const subnet = `172.30.${50 + (process.pid % 50)}.0/24`;
    const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');
    let image = '';
    let rootToken = '';

    const secrets: string[] = [];
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
      if (r.status !== 0) {
        throw new Error(`${what} failed (exit ${r.status}): ${redact(r.stderr + r.stdout)}`);
      }
      return r;
    };
    const compose = (...args: string[]): Result =>
      run('docker', [
        'compose',
        '-f',
        path.join(deployDir, 'docker-compose.yml'),
        '--env-file',
        envFile,
        ...args,
      ]);
    const bootstrapCmd = (args: string[], input = ''): Result =>
      run(bootstrap, args, input, { SDLC_OPENBAO_TEST: '1' });

    // Reads the role ID and secret ID a rotation wrote into a service volume (read-only mount).
    const readCredentials = (volume: string): Credentials => {
      const name = `${project}_${volume}`;
      const r = ok(
        run('docker', [
          'run',
          '--rm',
          '--user',
          '0',
          '--network',
          'none',
          '-v',
          `${name}:/v:ro`,
          '--entrypoint',
          'sh',
          image,
          '-c',
          'cat /v/role_id /v/secret_id',
        ]),
        `read ${volume}`,
      );
      const [roleId = '', secretId = ''] = r.stdout.split('\n');
      return { roleId: keep(roleId.trim()), secretId: keep(secretId.trim()) };
    };

    // AppRole login from a fresh container on the Compose network (inside the secret-ID CIDR), like
    // a platform process. Role ID and secret ID go on stdin; the token is kept, never printed.
    const login = (c: Credentials): Result => {
      const r = run(
        'docker',
        [
          'run',
          '--rm',
          '-i',
          '--network',
          network,
          '-e',
          'BAO_ADDR=http://openbao:8200',
          '--entrypoint',
          'sh',
          image,
          '-c',
          'IFS= read -r r; IFS= read -r s; printf %s "$s" | bao write -field=token auth/approle/login role_id="$r" secret_id=-',
        ],
        `${c.roleId}\n${c.secretId}\n`,
      );
      keep(r.stdout.trim());
      return r;
    };

    // Number of secret IDs the AppRole has (accessors listed with the root token, inside the
    // openbao container). Only the count leaves the container.
    const secretIdCount = (role: string): number => {
      const r = ok(
        run(
          'docker',
          [
            'compose',
            '-f',
            path.join(deployDir, 'docker-compose.yml'),
            '--env-file',
            envFile,
            'exec',
            '-T',
            'openbao',
            'sh',
            '-c',
            'IFS= read -r BAO_TOKEN && export BAO_TOKEN && bao list -format=json "auth/approle/role/$1/secret-id" | tr -d "[]\\", " | grep -c .',
            'sh',
            role,
          ],
          `${rootToken}\n`,
        ),
        `count ${role} secret IDs`,
      );
      return Number(r.stdout.trim());
    };

    beforeAll(() => {
      ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
      const text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
        project,
        subnet,
        gateway: subnet.replace(/0\/24$/, '1'),
        portOffset: PORT_OFFSET,
      });
      fs.writeFileSync(envFile, text, { mode: 0o600 });
      for (const line of text.split('\n')) {
        if (/_PASSWORD=/.test(line)) keep(line.slice(line.indexOf('=') + 1));
      }
      image = openbaoImage();

      ok(compose('--profile', 'core', 'up', '-d', '--wait', 'openbao'), 'compose up openbao');
      const init = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
      const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
      ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
      ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');
      // Build the service images once, so the timed tests below only rotate.
      ok(
        compose(
          '--profile',
          'core',
          '--profile',
          'platform',
          '--profile',
          'sandbox',
          'build',
          'sdlc-api',
          'sdlc-worker',
          'sdlc-runner',
        ),
        'build',
      );
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      compose(
        '--profile',
        'core',
        '--profile',
        'platform',
        '--profile',
        'sandbox',
        '--profile',
        'models',
        'down',
        '--volumes',
        '--remove-orphans',
      );
      fs.rmSync(tmp, { recursive: true, force: true });
    }, SETUP_TIMEOUT_MS);

    for (const { role, command, volume } of ROTATIONS) {
      it(`${role} (${command} again): the new secret ID logs in, the old one is refused`, () => {
        ok(bootstrapCmd([command], `${rootToken}\n`), command);
        const old = readCredentials(volume);

        ok(bootstrapCmd([command], `${rootToken}\n`), `${command} again`);
        const now = readCredentials(volume);
        expect(now.roleId === old.roleId, 'same role ID').toBe(true);
        expect(now.secretId === old.secretId, 'a new secret ID').toBe(false);
        expect(secretIdCount(role)).toBe(1);

        const fresh = login(now);
        expect(fresh.status, `new secret ID login (${redact(fresh.stderr)})`).toBe(0);

        const stale = login(old);
        expect(stale.status, 'old secret ID must be refused').not.toBe(0);
        // Refused by OpenBao, not a network or client error.
        expect(redact(stale.stderr)).toMatch(/invalid (role or )?secret id/i);
      });
    }

    // Runbook T11 §8.3: destroying a secret ID leaves its tokens valid until their TTL; the
    // runbook's command revokes the tokens of one AppRole only. The loop is taken from the
    // runbook text, so the documented command is the tested one.
    it('a token issued before a rotation stays valid; the T11 §8.3 command revokes it', () => {
      const runbook = fs.readFileSync(
        path.join(deployDir, '../../handbook/03-templates/T11-openbao-runbook.md'),
        'utf8',
      );
      const section = runbook.slice(runbook.indexOf('### 8.3.'));
      const start = section.indexOf('role=api; n=0');
      const stop = section.indexOf('echo "revoked', start);
      expect(start, 'T11 §8.3 revoke loop').toBeGreaterThan(0);
      // Inside `sh -c '…'` in the runbook: the inner shell gets the text exactly as written.
      const loop = section.slice(start, stop);
      const revoke = `IFS= read -r BAO_TOKEN; export BAO_TOKEN\n${loop}echo "revoked $n"`;

      const tokenOf = (volume: string): string =>
        keep(ok(login(readCredentials(volume)), `login ${volume}`).stdout.trim());
      const valid = (token: string): boolean =>
        run(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--network',
            network,
            '-e',
            'BAO_ADDR=http://openbao:8200',
            '--entrypoint',
            'sh',
            image,
            '-c',
            'IFS= read -r BAO_TOKEN && export BAO_TOKEN && bao token lookup >/dev/null',
          ],
          `${token}\n`,
        ).status === 0;

      const apiToken = tokenOf('api-approle');
      const workerToken = tokenOf('worker-approle');
      ok(bootstrapCmd(['api-credentials'], `${rootToken}\n`), 'api-credentials');
      expect(valid(apiToken), 'api token after the rotation').toBe(true);

      const r = ok(
        run(
          'docker',
          [
            'compose',
            '-f',
            path.join(deployDir, 'docker-compose.yml'),
            '--env-file',
            envFile,
            'exec',
            '-T',
            'openbao',
            'sh',
            '-c',
            revoke,
          ],
          `${rootToken}\n`,
        ),
        'T11 §8.3 revoke',
      );
      expect(r.stdout).toMatch(/^revoked [1-9]\d*$/m);
      expect(valid(apiToken), 'api token after the revoke').toBe(false);
      expect(valid(workerToken), 'worker token is not touched').toBe(true);
    });
  },
);
