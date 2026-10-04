// D-08 E05 PR 1 (design/ADR-M51 §2.1–§2.3): live test of the object lock on the bucket `evidence`
// (set by `seaweedfs-init`) and of `bootstrap.sh worker-purge-credentials`, on the pinned SeaweedFS
// and OpenBao. Needs Docker. Skipped unless SDLC_OPENBAO_TEST=1. Run with: pnpm test:openbao
//
// - The bucket is locked GOVERNANCE for 180 days by default; a re-run of the init changes nothing.
// - The writers (`runner-evidence`, `api-evidence`) cannot delete a version of their own files: the
//   lock refuses it; a plain delete only leaves a delete marker.
// - The purge identity `worker-purge`: without the bypass it is refused; with it, every version and
//   delete marker goes; a legal hold refuses even the bypass; it moves a lock forward, never back;
//   it lists keys; it cannot read a file or touch another prefix; a rotation disables the old key.
// Key shares, tokens and S3 keys are THROW-AWAY TEST KEYS: kept in variables, never printed.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3EvidenceStore, S3RetentionStore } from '@sdlc/adapter-evidence-s3';
import type { RedactedSecret } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir, parseEnvFile } from '../../deploy/compose';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_OPENBAO_TEST === '1';
const PORT_OFFSET = 28000;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const DAY = 86_400_000;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Keys {
  readonly access_key: string;
  readonly secret_key: string;
}

describe.skipIf(!enabled)(
  'evidence lock and worker-purge-credentials (live, E05)',
  { timeout: 120_000 },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-retention-it-'));
    const envFile = path.join(tmp, 'it.env');
    const project = `sdlcpurge${process.pid}`;
    // Subnets of the live test files stay apart: this file uses 250–254.
    const subnet = `172.30.${250 + (process.pid % 5)}.0/24`;
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
    const outputs: string[] = [];

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
      if (/-credentials$/.test(args[0] ?? '')) outputs.push(result.stdout + result.stderr);
      return result;
    };
    const secret = (value: string): RedactedSecret =>
      ({ reveal: () => value, toString: () => '[redacted]' }) as RedactedSecret;
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
    const writer = (keys: Keys, keyPrefix: string) =>
      new S3EvidenceStore({
        endpoint: s3Url,
        bucket: 'evidence',
        keyPrefix,
        accessKeyId: secret(keys.access_key),
        secretAccessKey: secret(keys.secret_key),
        timeoutMs: 10_000,
      });
    const purger = (keys: Keys) =>
      new S3RetentionStore({
        endpoint: s3Url,
        bucket: 'evidence',
        prefixes: ['proposals/', 'diffs/', 'packs/'],
        accessKeyId: secret(keys.access_key),
        secretAccessKey: secret(keys.secret_key),
        timeoutMs: 10_000,
      });
    const client = (keys: { accessKeyId: string; secretAccessKey: string }) =>
      new S3Client({
        endpoint: s3Url,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: keys,
      });
    const versionsOf = async (key: string) => {
      const s3 = client(admin!);
      try {
        const answer = await s3.send(
          new ListObjectVersionsCommand({ Bucket: 'evidence', Prefix: key }),
        );
        return [...(answer.Versions ?? []), ...(answer.DeleteMarkers ?? [])].filter(
          (v) => v.Key === key,
        );
      } finally {
        s3.destroy();
      }
    };
    const keyOf = (uri: string) => uri.slice('s3://evidence/'.length);

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
      ok(compose('run', '--rm', '--no-deps', 'seaweedfs-init'), 'seaweedfs-init');
      const init = ok(bootstrapCmd(['init', '--stdout-not-tty']), 'init');
      const shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
      rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
      ok(bootstrapCmd(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
      ok(bootstrapCmd(['configure', '--keep-token'], `${rootToken}\n`), 'configure');
      for (const command of [
        'runner-evidence-credentials',
        'api-evidence-credentials',
        'worker-purge-credentials',
      ]) {
        ok(bootstrapCmd([command], `${rootToken}\n`), command);
      }
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      compose('down', '--volumes', '--remove-orphans');
      fs.rmSync(tmp, { recursive: true, force: true });
    }, SETUP_TIMEOUT_MS);

    it('locks the bucket evidence GOVERNANCE for 180 days; a re-run of the init changes nothing', async () => {
      ok(compose('run', '--rm', '--no-deps', 'seaweedfs-init'), 'seaweedfs-init again');
      const s3 = client(admin!);
      try {
        const lock = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: 'evidence' }));
        expect(lock.ObjectLockConfiguration?.ObjectLockEnabled).toBe('Enabled');
        expect(lock.ObjectLockConfiguration?.Rule?.DefaultRetention).toEqual({
          Mode: 'GOVERNANCE',
          Days: 180,
        });
      } finally {
        s3.destroy();
      }
    });

    it('every new version is locked: the writers cannot delete a version, a plain delete leaves a marker', async () => {
      const runner = keysAt('runner/evidence');
      const api = keysAt('api/evidence');
      const tenant = crypto.randomUUID();
      const diffs = writer(runner, 'diffs/');
      const packs = writer(api, 'packs/');
      try {
        const d = await diffs.put(tenant, 'i/r.patch', Buffer.from('diff\n'), 'text/x-diff');
        const p = await packs.put(tenant, 'i/p/pack.md', Buffer.from('# pack\n'), 'text/markdown');
        for (const [stored, keys] of [
          [d, runner],
          [p, api],
        ] as const) {
          const [version] = await versionsOf(keyOf(stored.uri));
          const s3 = client({ accessKeyId: keys.access_key, secretAccessKey: keys.secret_key });
          const adminS3 = client(admin!);
          try {
            const retention = await adminS3.send(
              new GetObjectRetentionCommand({
                Bucket: 'evidence',
                Key: keyOf(stored.uri),
                VersionId: version!.VersionId,
              }),
            );
            expect(retention.Retention?.Mode).toBe('GOVERNANCE');
            expect(retention.Retention!.RetainUntilDate!.getTime()).toBeGreaterThan(
              Date.now() + 179 * DAY,
            );
            await expect(
              s3.send(
                new DeleteObjectCommand({
                  Bucket: 'evidence',
                  Key: keyOf(stored.uri),
                  VersionId: version!.VersionId,
                  BypassGovernanceRetention: true,
                }),
              ),
            ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
          } finally {
            s3.destroy();
            adminS3.destroy();
          }
        }
        // The runner's plain delete: a marker, the locked version stays.
        const s3 = client({ accessKeyId: runner.access_key, secretAccessKey: runner.secret_key });
        await s3.send(new DeleteObjectCommand({ Bucket: 'evidence', Key: keyOf(d.uri) }));
        s3.destroy();
        const after = await versionsOf(keyOf(d.uri));
        expect(after.length).toBe(2);
      } finally {
        diffs.destroy();
        packs.destroy();
      }
    });

    it('worker-purge: refused without the bypass; with it every version and marker goes', async () => {
      const runner = keysAt('runner/evidence');
      const purge = purger(keysAt('worker/purge'));
      const tenant = crypto.randomUUID();
      const proposals = writer(runner, 'proposals/');
      try {
        const stored = await proposals.put(tenant, 'i/r.patch', Buffer.from('p\n'), 'text/x-diff');
        const s3 = client({ accessKeyId: runner.access_key, secretAccessKey: runner.secret_key });
        await s3.send(new DeleteObjectCommand({ Bucket: 'evidence', Key: keyOf(stored.uri) }));
        s3.destroy();
        await expect(
          purge.deleteAllVersions(stored.uri, { bypassLock: false }),
        ).rejects.toMatchObject({
          code: 'forbidden',
        });
        expect(await purge.deleteAllVersions(stored.uri, { bypassLock: true })).toBe(2);
        expect(await versionsOf(keyOf(stored.uri))).toEqual([]);
        expect(await purge.deleteAllVersions(stored.uri, { bypassLock: true })).toBe(0);
      } finally {
        proposals.destroy();
        purge.destroy();
      }
    });

    it('worker-purge: a legal hold refuses even the bypass; moves a lock forward, never back', async () => {
      const api = keysAt('api/evidence');
      const purge = purger(keysAt('worker/purge'));
      const tenant = crypto.randomUUID();
      const packs = writer(api, 'packs/');
      try {
        const stored = await packs.put(
          tenant,
          'i/p/manifest.json',
          Buffer.from('{}'),
          'application/json',
        );
        expect(await purge.setLegalHold(stored.uri, true)).toBe(1);
        await expect(
          purge.deleteAllVersions(stored.uri, { bypassLock: true }),
        ).rejects.toMatchObject({
          code: 'forbidden',
        });
        expect(await purge.setLegalHold(stored.uri, false)).toBe(1);
        const far = new Date(Date.now() + 400 * DAY);
        expect(await purge.extendLock(stored.uri, far)).toBe(1);
        expect(await purge.extendLock(stored.uri, new Date(Date.now() + 300 * DAY))).toBe(0);
        const page = await purge.listKeys('packs/', null, 1000);
        expect(page.keys.map((k) => k.uri)).toContain(stored.uri);
        expect(await purge.deleteAllVersions(stored.uri, { bypassLock: true })).toBe(1);
      } finally {
        packs.destroy();
        purge.destroy();
      }
    });

    it('worker-purge never reads a file and writes under no other prefix', async () => {
      const runner = keysAt('runner/evidence');
      const keys = keysAt('worker/purge');
      const tenant = crypto.randomUUID();
      const diffs = writer(runner, 'diffs/');
      const s3 = client({ accessKeyId: keys.access_key, secretAccessKey: keys.secret_key });
      try {
        const stored = await diffs.put(
          tenant,
          'i/r.patch',
          Buffer.from('secret code\n'),
          'text/x-diff',
        );
        await expect(
          s3.send(new GetObjectCommand({ Bucket: 'evidence', Key: keyOf(stored.uri) })),
        ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
        const other = writer(keys, 'other/');
        await expect(other.put(tenant, 'x', Buffer.from('x'), 'text/plain')).rejects.toMatchObject({
          code: 'forbidden',
        });
        other.destroy();
      } finally {
        diffs.destroy();
        s3.destroy();
      }
    });

    it('worker-purge rotates: the old key stops working', async () => {
      const old = keysAt('worker/purge');
      ok(bootstrapCmd(['worker-purge-credentials'], `${rootToken}\n`), 'rotate');
      const fresh = keysAt('worker/purge');
      expect(fresh.access_key).not.toBe(old.access_key);
      const oldPurge = purger(old);
      const newPurge = purger(fresh);
      try {
        await expect(oldPurge.listKeys('packs/', null, 1)).rejects.toMatchObject({
          code: 'forbidden',
        });
        await newPurge.listKeys('packs/', null, 1);
      } finally {
        oldPurge.destroy();
        newPurge.destroy();
      }
    });

    it('the credentials commands never printed a key or the token', () => {
      expect(outputs.length).toBeGreaterThanOrEqual(4);
      for (const output of outputs) {
        for (const value of secrets) {
          expect(output.includes(value), 'a secret is in the command output').toBe(false);
        }
      }
    });
  },
);
