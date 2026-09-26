// D-08 task C02 AC1: live test of Run Contract signing with the real OpenBao Transit key
// `run-contract` (design/ADR-M22). Needs Docker. Skipped unless SDLC_OPENBAO_TEST=1.
// Run with: pnpm test:openbao
//
// The worker AppRole signs the canonical bytes of a Run Contract; the runner AppRole verifies them
// through Transit and locally; the runner cannot sign. After a key rotation (throw-away root
// token), new contracts are signed with version 2 and version-1 contracts still verify.
// Own throw-away Compose project with only the openbao service; the client runs in a node
// container on the Compose network (secrets-driver.mjs). Key shares, tokens and secret IDs are
// THROW-AWAY TEST KEYS: kept in variables of this process, never printed or asserted on.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runContractBytes } from '../../../packages/core/src/run-contract/canonical.js';
import { deployDir, root } from '../../deploy/compose';
import { SAMPLE_CONTRACT } from '../../run-contract/helpers';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_OPENBAO_TEST === '1';
const PORT_OFFSET = 23000;
const SETUP_TIMEOUT_MS = 5 * 60 * 1000;
const TEST_TIMEOUT_MS = 2 * 60 * 1000;
// Same pinned image as secrets-client.test.ts.
const NODE_IMAGE =
  'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
const DRIVER = '/repo/platform/tests/integration/openbao/secrets-driver.mjs';
// The exact bytes the worker signs: RFC 8785 canonical JSON of the contract (UTF-8 text).
const CANONICAL = new TextDecoder().decode(runContractBytes(SAMPLE_CONTRACT));
const CHANGED = new TextDecoder().decode(
  runContractBytes({ ...SAMPLE_CONTRACT, max_budget_usd: '200' }),
);

type Role = 'worker' | 'runner';

interface StepResult {
  step: string;
  ok: boolean;
  value?: unknown;
  key?: string;
}

describe.skipIf(!enabled)(
  'Run Contract signing with OpenBao (live)',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-run-contract-it-'));
    const envFile = path.join(tmp, 'it.env');
    const project = `sdlcrc${process.pid}`;
    const network = `${project}-net`;
    const subnet = `172.30.${150 + (process.pid % 50)}.0/24`;
    const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');

    const secrets: string[] = [];
    let rootToken = '';
    const roleIds = new Map<Role, string>();
    const secretIds = new Map<Role, string>();
    let v1Signature = '';

    const keep = (value: string): string => {
      if (value) secrets.push(value);
      return value;
    };
    const redact = (text: string): string =>
      secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);
    const run = (cmd: string, args: string[], input = '', env: NodeJS.ProcessEnv = {}) => {
      const r = spawnSync(cmd, args, {
        encoding: 'utf8',
        input,
        env: { ...process.env, SDLC_ENV_FILE: envFile, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    const ok = (r: ReturnType<typeof run>, what: string) => {
      if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${redact(r.stderr)}`);
      return r;
    };
    const compose = (input: string, ...args: string[]) =>
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

    /** Runs the @sdlc/secrets client as `role` in a node container on the Compose network. */
    const steps = (role: Role, list: ({ name: string } & Record<string, unknown>)[]) => {
      const r = ok(
        run(
          'docker',
          [
            'run',
            '--rm',
            '-i',
            '--network',
            network,
            '--user',
            'node',
            '--tmpfs',
            '/run/sdlc:uid=1000,gid=1000,mode=0700',
            '-v',
            `${root}:/repo:ro`,
            '-e',
            'SDLC_OPENBAO_ADDR=http://openbao:8200',
            '-e',
            'SECRETS_DIST=/repo/platform/packages/secrets/dist/index.js',
            NODE_IMAGE,
            'node',
            DRIVER,
          ],
          JSON.stringify({ roleId: roleIds.get(role), secretId: secretIds.get(role), steps: list }),
        ),
        'driver',
      );
      return (JSON.parse(r.stdout) as { results: StepResult[] }).results;
    };

    beforeAll(() => {
      ok(
        run(path.join(root, 'node_modules/.bin/tsc'), ['-b', 'platform/packages/secrets']),
        'build',
      );
      ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
      // Own project, subnet and gateway (A11: the gateway must be inside the subnet).
      const text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
        project,
        subnet,
        gateway: subnet.replace(/0\/24$/, '1'),
        portOffset: PORT_OFFSET,
      });
      fs.writeFileSync(envFile, text, { mode: 0o600 });
      ok(compose('', '--profile', 'core', 'up', '-d', '--wait', 'openbao'), 'compose up openbao');
      ok(run('docker', ['pull', '-q', NODE_IMAGE]), 'pull node image');

      const init = ok(
        run(bootstrap, ['init', '--stdout-not-tty'], '', { SDLC_OPENBAO_TEST: '1' }),
        'init',
      );
      const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
      ok(
        run(bootstrap, ['unseal'], `${shares[0]}\n${shares[1]}\n`, { SDLC_OPENBAO_TEST: '1' }),
        'unseal',
      );
      ok(
        run(bootstrap, ['configure', '--keep-token'], `${rootToken}\n`, { SDLC_OPENBAO_TEST: '1' }),
        'configure',
      );
      for (const role of ['worker', 'runner'] as const) {
        roleIds.set(role, admin(`bao read -field=role_id auth/approle/role/${role}/role-id`));
        secretIds.set(
          role,
          keep(admin(`bao write -f -field=secret_id auth/approle/role/${role}/secret-id`)),
        );
      }
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      compose('', '--profile', 'core', 'down', '--volumes', '--remove-orphans');
      fs.rmSync(tmp, { recursive: true, force: true });
    }, SETUP_TIMEOUT_MS);

    it('the worker signs the canonical contract with key version 1', () => {
      const [signed] = steps('worker', [{ name: 'sign', payload: CANONICAL }]);
      const value = signed?.value as { signature: string; keyVersion: number };
      expect(value.keyVersion).toBe(1);
      expect(value.signature).toMatch(/^vault:v1:/);
      v1Signature = value.signature;
    });

    it('the runner verifies it (Transit and locally), refuses a changed contract, cannot sign', () => {
      const r = steps('runner', [
        { name: 'verify', payload: CANONICAL, signature: v1Signature },
        { name: 'verifyLocally', payload: CANONICAL, signature: v1Signature },
        { name: 'verify', payload: CHANGED, signature: v1Signature },
        { name: 'verifyLocally', payload: CHANGED, signature: v1Signature },
        { name: 'sign', payload: CANONICAL },
      ]);
      expect(r.map((s) => s.value ?? s.key)).toEqual([
        true,
        true,
        false,
        false,
        'secrets.permission_denied',
      ]);
    });

    it('after a key rotation: new contracts use version 2, version-1 contracts still verify', () => {
      admin('bao write -f transit/keys/run-contract/rotate >/dev/null');
      const [signed] = steps('worker', [{ name: 'sign', payload: CANONICAL }]);
      const v2 = signed?.value as { signature: string; keyVersion: number };
      expect(v2.keyVersion).toBe(2);
      expect(v2.signature).toMatch(/^vault:v2:/);
      const relabelled = v1Signature.replace(/^vault:v1:/, 'vault:v2:');
      const r = steps('runner', [
        { name: 'verify', payload: CANONICAL, signature: v1Signature },
        { name: 'verifyLocally', payload: CANONICAL, signature: v1Signature },
        { name: 'verifyLocally', payload: CANONICAL, signature: v2.signature },
        { name: 'verifyLocally', payload: CANONICAL, signature: relabelled },
        { name: 'publicKeyLength', version: 2 },
      ]);
      expect(r.map((s) => s.value ?? s.key)).toEqual([true, true, true, false, 32]);
    });
  },
);
