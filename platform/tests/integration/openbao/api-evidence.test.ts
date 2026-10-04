// D-08 E02 (design/ADR-M48 §2.2) and E03 (design/ADR-M49 §2.2): live test of `bootstrap.sh
// api-evidence-credentials` and `worker-evidence-credentials`.
// Needs Docker. Skipped unless SDLC_OPENBAO_TEST=1. Run with: pnpm test:openbao
//
// Own throw-away Compose project (own name, ports, subnet, random env file) with OpenBao and
// SeaweedFS only, removed afterwards. The api's identity `api-evidence` and the worker's
// `worker-evidence` (the same rights, its own key) may each read
// `evidence/proposals/*` and `evidence/diffs/*` (the hash re-check), read and write
// `evidence/packs/*`, and nothing else; a pack is never overwritten; a rotation disables the old
// key. Key shares, tokens and S3 keys are THROW-AWAY TEST KEYS: kept in variables, never printed,
// never in an assertion message.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3EvidenceStore } from '@sdlc/adapter-evidence-s3';
import type { RedactedSecret } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir, parseEnvFile } from '../../deploy/compose';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_OPENBAO_TEST === '1';
const PORT_OFFSET = 29000;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Keys {
  readonly access_key: string;
  readonly secret_key: string;
}

/** The processes that build Evidence Packs, each with its own identity (ADR-M49 §2.2). */
const ROLES = ['api', 'worker'] as const;

describe.skipIf(!enabled)(
  'api- and worker-evidence-credentials (live, E02, E03)',
  { timeout: 120_000 },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-api-evidence-it-'));
    const envFile = path.join(tmp, 'it.env');
    const project = `sdlcapiev${process.pid}`;
    // Subnets of the live test files stay apart: this file uses 1–49.
    const subnet = `172.30.${1 + (process.pid % 49)}.0/24`;
    const gateway = subnet.replace(/0\/24$/, '1');
    const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');

    const secrets: string[] = [];
    const keep = (value: string): string => {
      if (value) secrets.push(value);
      return value;
    };
    const redact = (text: string): string =>
      secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), text);
    let rootToken = '';
    let s3Url = '';
    let admin: { accessKeyId: string; secretAccessKey: string } | undefined;
    /** Outputs of the evidence-credentials commands: they must never hold a key or the token. */
    const apiOutputs: string[] = [];

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
    const composeIn = (input: string, ...args: string[]): Result =>
      run(
        'docker',
        [
          'compose',
          '-f',
          path.join(deployDir, 'docker-compose.yml'),
          '--env-file',
          envFile,
          '--profile',
          'core',
          ...args,
        ],
        input,
      );
    const compose = (...args: string[]): Result => composeIn('', ...args);
    const bootstrapCmd = (args: string[], input = ''): Result => {
      const result = run(bootstrap, args, input, { SDLC_OPENBAO_TEST: '1' });
      if (/^(api|worker)-evidence-credentials$/.test(args[0] ?? '')) {
        apiOutputs.push(result.stdout + result.stderr);
      }
      return result;
    };
    const secret = (value: string): RedactedSecret =>
      ({ reveal: () => value, toString: () => '[redacted]' }) as RedactedSecret;
    /** Keys of an identity, read from OpenBao with the throw-away root token. */
    const keysAt = (kvPath: string): Keys => {
      const read = ok(
        composeIn(
          `${rootToken}\n`,
          'exec',
          '-T',
          'openbao',
          'sh',
          '-c',
          'IFS= read -r BAO_TOKEN && export BAO_TOKEN BAO_ADDR=http://127.0.0.1:8200 && ' +
            `bao kv get -mount=kv -format=json -field=data ${kvPath}`,
        ),
        `kv get ${kvPath}`,
      );
      const data = JSON.parse(read.stdout) as Keys;
      keep(data.access_key);
      keep(data.secret_key);
      return data;
    };
    const store = (keys: Keys, keyPrefix: string) =>
      new S3EvidenceStore({
        endpoint: s3Url,
        bucket: 'evidence',
        keyPrefix,
        accessKeyId: secret(keys.access_key),
        secretAccessKey: secret(keys.secret_key),
        timeoutMs: 10_000,
      });
    const adminS3 = () =>
      new S3Client({
        endpoint: s3Url,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: admin!,
      });

    beforeAll(() => {
      ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
      const text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
        project,
        subnet,
        gateway,
        portOffset: PORT_OFFSET,
      });
      fs.writeFileSync(envFile, text, { mode: 0o600 });
      const env = parseEnvFile(text);
      admin = {
        accessKeyId: keep(env.get('SEAWEEDFS_S3_ACCESS_KEY')!),
        secretAccessKey: keep(env.get('SEAWEEDFS_S3_SECRET_KEY')!),
      };
      s3Url = `http://127.0.0.1:${env.get('SEAWEEDFS_S3_HOST_PORT')!}`;
      ok(compose('up', '-d', '--wait', 'openbao', 'seaweedfs'), 'compose up');
      // The bucket `evidence` with versioning (the one-shot init of the core profile).
      ok(compose('run', '--rm', '--no-deps', 'seaweedfs-init'), 'seaweedfs-init');
      const init = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
      const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
      ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
      ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');
      ok(bootstrapCmd(['runner-evidence-credentials'], `${rootToken}\n`), 'runner-evidence');
      for (const role of ROLES) {
        const out = ok(
          bootstrapCmd([`${role}-evidence-credentials`], `${rootToken}\n`),
          `${role}-evidence`,
        );
        expect(out.stdout).toContain(`${role}-evidence`);
      }
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      compose('down', '--volumes', '--remove-orphans');
      fs.rmSync(tmp, { recursive: true, force: true });
    }, SETUP_TIMEOUT_MS);

    for (const role of ROLES) {
      it(`${role}: reads the proposals and diffs the runner wrote, within maxBytes (the hash re-check)`, async () => {
        const runner = keysAt('runner/evidence');
        const api = keysAt(`${role}/evidence`);
        const tenant = crypto.randomUUID();
        const proposals = store(runner, 'proposals/');
        const diffs = store(runner, 'diffs/');
        const reader = store(api, 'packs/');
        try {
          const p = await proposals.put(
            tenant,
            'i/r.patch',
            Buffer.from('proposal\n'),
            'text/x-diff',
          );
          const d = await diffs.put(tenant, 'i/r.patch', Buffer.from('diff\n'), 'text/x-diff');
          expect((await reader.get(p.uri, { maxBytes: p.sizeBytes })).toString()).toBe(
            'proposal\n',
          );
          expect((await reader.get(d.uri, { maxBytes: d.sizeBytes })).toString()).toBe('diff\n');
          await expect(reader.get(d.uri, { maxBytes: 1 })).rejects.toMatchObject({
            code: 'too_large',
          });
        } finally {
          proposals.destroy();
          diffs.destroy();
          reader.destroy();
        }
      });
    }

    for (const role of ROLES) {
      it(`${role}: writes and reads packs under packs/ only; never overwrites; cannot write proposals or diffs`, async () => {
        const api = keysAt(`${role}/evidence`);
        const tenant = crypto.randomUUID();
        const packs = store(api, 'packs/');
        const proposals = store(api, 'proposals/');
        const diffs = store(api, 'diffs/');
        const other = store(api, 'other/');
        try {
          const stored = await packs.put(
            tenant,
            'i/p/pack.md',
            Buffer.from('# pack\n'),
            'text/markdown',
          );
          expect(stored.uri).toBe(`s3://evidence/packs/${tenant}/i/p/pack.md`);
          expect((await packs.get(stored.uri)).toString()).toBe('# pack\n');
          await expect(
            packs.put(tenant, 'i/p/pack.md', Buffer.from('other\n'), 'text/markdown'),
          ).rejects.toMatchObject({ code: 'exists' });
          for (const outside of [proposals, diffs, other]) {
            await expect(
              outside.put(tenant, 'i/x.patch', Buffer.from('x'), 'text/x-diff'),
            ).rejects.toMatchObject({ code: 'forbidden' });
          }
        } finally {
          packs.destroy();
          proposals.destroy();
          diffs.destroy();
          other.destroy();
        }
      });
    }

    for (const role of ROLES) {
      it(`${role}: cannot read another prefix of the bucket`, async () => {
        const api = keysAt(`${role}/evidence`);
        const s3 = adminS3();
        const key = `other/${crypto.randomUUID()}/x.txt`;
        try {
          await s3.send(new PutObjectCommand({ Bucket: 'evidence', Key: key, Body: 'x' }));
          const reader = store(api, 'packs/');
          await expect(reader.get(`s3://evidence/${key}`)).rejects.toMatchObject({
            code: 'forbidden',
          });
          reader.destroy();
          // The admin still reads it: the refusal is the identity's, not a missing object.
          const answer = await s3.send(new GetObjectCommand({ Bucket: 'evidence', Key: key }));
          expect(await answer.Body?.transformToString()).toBe('x');
        } finally {
          s3.destroy();
        }
      });
    }

    for (const role of ROLES) {
      it(`${role}: rotates: the old key stops working, the new one works`, async () => {
        const old = keysAt(`${role}/evidence`);
        ok(bootstrapCmd([`${role}-evidence-credentials`], `${rootToken}\n`), 'rotate');
        const fresh = keysAt(`${role}/evidence`);
        expect(fresh.access_key).not.toBe(old.access_key);
        const tenant = crypto.randomUUID();
        const oldStore = store(old, 'packs/');
        const newStore = store(fresh, 'packs/');
        try {
          await expect(
            oldStore.put(tenant, 'i/a.md', Buffer.from('x'), 'text/markdown'),
          ).rejects.toMatchObject({ code: 'forbidden' });
          await newStore.put(tenant, 'i/b.md', Buffer.from('x'), 'text/markdown');
        } finally {
          oldStore.destroy();
          newStore.destroy();
        }
      });
    }

    it('the evidence-credentials commands never printed a key or the token', () => {
      expect(apiOutputs.length).toBeGreaterThanOrEqual(4);
      for (const output of apiOutputs) {
        for (const value of secrets) {
          expect(output.includes(value), 'a secret is in the command output').toBe(false);
        }
      }
    });
  },
);
