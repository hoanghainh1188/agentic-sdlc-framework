// D-08 E05 PR 2 (AC4, design/ADR-M51 §2.9): live test of the bucket `audit-anchors` (set by
// `seaweedfs-init`) and of `bootstrap.sh worker-anchor-credentials`, on the pinned SeaweedFS and
// OpenBao. Needs Docker. Skipped unless SDLC_OPENBAO_TEST=1. Run with: pnpm test:openbao
//
// - The bucket is versioned and locked COMPLIANCE for 731 days; a re-run of the init changes
//   nothing, and `evidence` keeps its GOVERNANCE lock.
// - `worker-anchor` (through `S3AuditAnchorStore`): writes a key once (a second write is
//   `exists`), reads it back with its COMPLIANCE lock, lists its versions. Nobody can delete a
//   version or shorten its lock, the admin included. A plain delete leaves a delete marker, after
//   which a second version can be written: the store lists both and the marker, so the check sees
//   it (`anchor_versions`).
// - `worker-anchor` cannot touch `evidence`; the evidence writers cannot touch `audit-anchors`.
// - A rotation disables the old key.
// Key shares, tokens and S3 keys are THROW-AWAY TEST KEYS: kept in variables, never printed.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DeleteObjectCommand,
  GetObjectLockConfigurationCommand,
  GetBucketVersioningCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectRetentionCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3AuditAnchorStore } from '@sdlc/adapter-evidence-s3';
import type { RedactedSecret } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  anchorBytes,
  anchorKey,
  anchorLockHolds,
} from '../../../packages/core/src/audit/anchor.js';
import { deployDir, parseEnvFile } from '../../deploy/compose';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_OPENBAO_TEST === '1';
const PORT_OFFSET = 30000;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const BUCKET = 'audit-anchors';

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
  'audit-anchors and worker-anchor-credentials (live, E05 PR 2)',
  { timeout: 120_000 },
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-anchor-it-'));
    const envFile = path.join(tmp, 'it.env');
    const project = `sdlcanchor${process.pid}`;
    // Subnets of the openbao live test files stay apart: this file uses 200–224.
    const subnet = `172.30.${200 + (process.pid % 25)}.0/24`;
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
          'IFS= read -r BAO_TOKEN && export BAO_TOKEN && ' +
            `bao kv get -mount=kv -format=json -field=data ${kvPath}`,
        ),
        `kv get ${kvPath}`,
      );
      const data = JSON.parse(read.stdout) as Keys;
      keep(data.access_key);
      keep(data.secret_key);
      return data;
    };
    const anchors = (keys: Keys) =>
      new S3AuditAnchorStore({
        endpoint: s3Url,
        bucket: BUCKET,
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
    const asKeys = (keys: Keys) => ({
      accessKeyId: keys.access_key,
      secretAccessKey: keys.secret_key,
    });
    const anchorFor = (tenant: string, seq: number) => {
      const at = new Date();
      return {
        key: anchorKey(tenant, at),
        at,
        bytes: anchorBytes({
          tenantId: tenant,
          seq,
          hash: crypto.randomBytes(32).toString('hex'),
          hashVersion: 1,
          anchoredAt: at,
        }),
      };
    };

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
        'worker-anchor-credentials',
        'runner-evidence-credentials',
        'api-evidence-credentials',
      ]) {
        ok(bootstrapCmd([command], `${rootToken}\n`), command);
      }
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      compose('down', '--volumes', '--remove-orphans');
      fs.rmSync(tmp, { recursive: true, force: true });
    }, SETUP_TIMEOUT_MS);

    it('locks audit-anchors COMPLIANCE for 731 days, versioned; a re-run changes nothing', async () => {
      ok(compose('run', '--rm', '--no-deps', 'seaweedfs-init'), 'seaweedfs-init again');
      const s3 = client(admin!);
      try {
        const lock = await s3.send(new GetObjectLockConfigurationCommand({ Bucket: BUCKET }));
        expect(lock.ObjectLockConfiguration?.Rule?.DefaultRetention).toEqual({
          Mode: 'COMPLIANCE',
          Days: 731,
        });
        const versioning = await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
        expect(versioning.Status).toBe('Enabled');
        const evidence = await s3.send(
          new GetObjectLockConfigurationCommand({ Bucket: 'evidence' }),
        );
        expect(evidence.ObjectLockConfiguration?.Rule?.DefaultRetention).toEqual({
          Mode: 'GOVERNANCE',
          Days: 180,
        });
      } finally {
        s3.destroy();
      }
    });

    it('worker-anchor writes a key once and reads it back with its COMPLIANCE lock', async () => {
      const store = anchors(keysAt('worker/anchor'));
      const tenant = crypto.randomUUID();
      const a = anchorFor(tenant, 5);
      try {
        const first = await store.put(a.key, a.bytes);
        expect(first.outcome).toBe('written');
        expect((await store.put(a.key, anchorFor(tenant, 6).bytes)).outcome).toBe('exists');
        const versions = await store.listVersions(tenant);
        expect(versions).toEqual([
          {
            key: a.key,
            versionId: (first as { versionId: string }).versionId,
            deleteMarker: false,
          },
        ]);
        expect(await store.get(a.key, versions[0]!.versionId, 1024)).toEqual(a.bytes);
        const lock = await store.retention(a.key, versions[0]!.versionId);
        expect(anchorLockHolds(lock, a.at)).toBe(true);
        // Another tenant's folder holds nothing of this one.
        expect(await store.listVersions(crypto.randomUUID())).toEqual([]);
      } finally {
        store.destroy();
      }
    });

    it('nobody deletes a version or shortens its lock; a delete marker and a second version stay visible', async () => {
      const keys = keysAt('worker/anchor');
      const store = anchors(keys);
      const tenant = crypto.randomUUID();
      const a = anchorFor(tenant, 1);
      const anchorS3 = client(asKeys(keys));
      const adminS3 = client(admin!);
      try {
        const written = await store.put(a.key, a.bytes);
        const versionId = (written as { versionId: string }).versionId;
        for (const s3 of [anchorS3, adminS3]) {
          await expect(
            s3.send(
              new DeleteObjectCommand({
                Bucket: BUCKET,
                Key: a.key,
                VersionId: versionId,
                BypassGovernanceRetention: true,
              }),
            ),
          ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
        }
        await expect(
          adminS3.send(
            new PutObjectRetentionCommand({
              Bucket: BUCKET,
              Key: a.key,
              VersionId: versionId,
              BypassGovernanceRetention: true,
              Retention: { Mode: 'GOVERNANCE', RetainUntilDate: new Date(Date.now() + 86_400_000) },
            }),
          ),
        ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
        // The identity's Write allows a plain delete: a marker, then a second version.
        await anchorS3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: a.key }));
        expect((await store.put(a.key, anchorFor(tenant, 2).bytes)).outcome).toBe('written');
        const versions = await store.listVersions(tenant);
        expect(versions.filter((v) => v.deleteMarker)).toHaveLength(1);
        expect(versions.filter((v) => !v.deleteMarker)).toHaveLength(2);
        // The original is still there, unchanged.
        expect(await store.get(a.key, versionId, 1024)).toEqual(a.bytes);
      } finally {
        anchorS3.destroy();
        adminS3.destroy();
        store.destroy();
      }
    });

    it('worker-anchor cannot touch evidence; the evidence writers cannot touch audit-anchors', async () => {
      const anchorS3 = client(asKeys(keysAt('worker/anchor')));
      const runner = keysAt('runner/evidence');
      const api = keysAt('api/evidence');
      try {
        await expect(
          anchorS3.send(new ListObjectsV2Command({ Bucket: 'evidence' })),
        ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
        await expect(
          anchorS3.send(new PutObjectCommand({ Bucket: 'evidence', Key: 'packs/x', Body: 'x' })),
        ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
        for (const keys of [runner, api]) {
          const s3 = client(asKeys(keys));
          const store = anchors(keys);
          try {
            await expect(
              s3.send(new ListObjectsV2Command({ Bucket: BUCKET })),
            ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
            const a = anchorFor(crypto.randomUUID(), 1);
            await expect(store.put(a.key, a.bytes)).rejects.toMatchObject({ code: 'forbidden' });
          } finally {
            s3.destroy();
            store.destroy();
          }
        }
      } finally {
        anchorS3.destroy();
      }
    });

    it('a rotation disables the old key; no command prints a secret', async () => {
      const old = keysAt('worker/anchor');
      ok(bootstrapCmd(['worker-anchor-credentials'], `${rootToken}\n`), 'rotate');
      const fresh = keysAt('worker/anchor');
      expect(fresh.access_key).not.toBe(old.access_key);
      expect(fresh.access_key).toMatch(/^sdlcwrkan[0-9a-f]{20}$/);
      const before = anchors(old);
      const after = anchors(fresh);
      const tenant = crypto.randomUUID();
      try {
        await expect(before.listVersions(tenant)).rejects.toMatchObject({ code: 'forbidden' });
        expect(await after.listVersions(tenant)).toEqual([]);
      } finally {
        before.destroy();
        after.destroy();
      }
      for (const output of outputs) {
        for (const value of secrets) expect(output).not.toContain(value);
      }
    });
  },
);
