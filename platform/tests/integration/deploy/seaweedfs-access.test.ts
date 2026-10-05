// D-08 task A12 AC1–AC3 (design/ADR-M52, QUESTIONS #239, #245, #246): live test on the pinned
// SeaweedFS. Needs Docker. Skipped unless SDLC_COMPOSE_IT=1. Run with: pnpm test:seaweedfs (CI
// `compose` job) or pnpm test:compose
//
// A throw-away Compose project with `seaweedfs` and `seaweedfs-init` only. An evidence object is
// written with the object lock (GOVERNANCE) and a legal hold. Then, from other containers on the
// project network:
// - the filer (GET, DELETE), the volume server (direct read of the object's file ID) and the master
//   are not reachable; a `weed shell` from outside cannot connect;
// - the S3 gateway's gRPC port answers, but its IAM and lifecycle calls without the filer key are
//   refused (QUESTIONS #245), and an identity they tried to add has no access;
// - Iceberg and Lance are off.
// The object, its version and its legal hold are still there afterwards. Inside the container:
// security.toml has mode 600 and four keys, the filer refuses a read without a token, and
// `weed shell` (admin work through `docker compose exec`) still works. start.sh fails closed.
// S3 keys are THROW-AWAY TEST KEYS: kept in variables, never printed.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GetObjectCommand,
  GetObjectLegalHoldCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir, loadCompose, parseEnvFile } from '../../deploy/compose';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_COMPOSE_IT === '1';
const PORT_OFFSET = 30500;
const SETUP_TIMEOUT_MS = 5 * 60 * 1000;
// gRPC client for the S3 gateway's gRPC port; test only, pinned by digest (v1.9.3).
const GRPCURL =
  'fullstorydev/grpcurl:v1.9.3@sha256:085e183ca334eb4e81ca81ee12cbb2b2737505d1d77f5e33dabc5d066593d998';
const BUCKET = 'evidence';
const KEY = 'a12/probe.txt';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], input = '', timeoutMs = 60_000): Result {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe.skipIf(!enabled)(
  'SeaweedFS internal access is closed (live, A12)',
  { timeout: 120_000 },
  () => {
    let tmp = '';
    let envFile = '';
    const project = `sdlcswfs${process.pid}`;
    // Subnets of the live test files stay apart: 172.30.x is taken, this file uses 172.29.10–14.
    const subnet = `172.29.${10 + (process.pid % 5)}.0/24`;
    const network = `${project}-net`;
    const image = loadCompose().services.seaweedfs?.image ?? '';
    // Large enough to be stored on a volume server (small files are kept inline in the filer).
    const body = crypto.randomBytes(48 * 1024).toString('hex');
    let s3: S3Client | undefined;
    let s3Url = '';
    let versionId = '';
    let fileId = '';
    let admin: { accessKeyId: string; secretAccessKey: string } | undefined;

    const compose = (args: string[], input = ''): Result =>
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
        SETUP_TIMEOUT_MS,
      );
    const must = (r: Result, what: string): string => {
      if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr.slice(-2000)}`);
      return r.stdout;
    };
    // `weed shell` inside the seaweedfs container, as the runbook and bootstrap.sh run it.
    const weedShell = (commands: string): Result =>
      compose(
        ['--profile', 'core', 'exec', '-T', 'seaweedfs', 'weed', 'shell', '-master=127.0.0.1:9333'],
        commands,
      );
    // A shell in a new container of the SeaweedFS image on the project network, like any other
    // process there (api, worker, runner, LiteLLM, Langfuse, Temporal).
    const probe = (script: string): Result =>
      run(
        'docker',
        ['run', '--rm', '--network', network, '--entrypoint', '/bin/sh', image, '-c', script],
        '',
        90_000,
      );
    const grpc = (method: string, request: unknown): Result =>
      run(
        'docker',
        [
          'run',
          '--rm',
          '-i',
          '--network',
          network,
          GRPCURL,
          '-plaintext',
          '-max-time',
          '20',
          '-d',
          '@',
          'seaweedfs:18333',
          method,
        ],
        JSON.stringify(request),
        90_000,
      );

    beforeAll(async () => {
      expect(image).toMatch(/^chrislusf\/seaweedfs:/);
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-seaweedfs-it-'));
      envFile = path.join(tmp, 'it.env');
      must(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
      const text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
        project,
        subnet,
        gateway: subnet.replace(/0\/24$/, '1'),
        portOffset: PORT_OFFSET,
      });
      fs.writeFileSync(envFile, text, { mode: 0o600 });
      const vars = parseEnvFile(text);
      admin = {
        accessKeyId: vars.get('SEAWEEDFS_S3_ACCESS_KEY')!,
        secretAccessKey: vars.get('SEAWEEDFS_S3_SECRET_KEY')!,
      };

      must(compose(['--profile', 'core', 'up', '-d', '--wait', 'seaweedfs']), 'seaweedfs up');
      must(compose(['--profile', 'core', 'up', '-d', '--no-deps', 'seaweedfs-init']), 'init up');
      const id = must(compose(['--profile', 'core', 'ps', '-a', '-q', 'seaweedfs-init']), 'ps')
        .trim()
        .split('\n')[0]!;
      expect(must(run('docker', ['wait', id], '', SETUP_TIMEOUT_MS), 'wait').trim()).toBe('0');

      s3Url = `http://127.0.0.1:${vars.get('SEAWEEDFS_S3_HOST_PORT')}`;
      s3 = new S3Client({
        endpoint: s3Url,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: admin,
      });
      const put = await s3.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: KEY, Body: body, ContentType: 'text/plain' }),
      );
      versionId = put.VersionId ?? '';
      expect(versionId).not.toBe('');
      await s3.send(
        new PutObjectLegalHoldCommand({
          Bucket: BUCKET,
          Key: KEY,
          VersionId: versionId,
          LegalHold: { Status: 'ON' },
        }),
      );
      // The file ID of the object's chunk, for the direct volume read.
      const versionDir = `/buckets/${BUCKET}/${KEY}.versions`;
      const listing = must(weedShell(`fs.ls ${versionDir}\n`), 'ls');
      const file = /v_[0-9a-f]+/.exec(listing)?.[0] ?? '';
      const meta = must(weedShell(`fs.meta.cat ${versionDir}/${file}\n`), 'meta');
      const ids = [...meta.matchAll(/"fileId":\s*"([0-9]+,[0-9a-f]+)"/g)].map((m) => m[1]!);
      fileId = ids[0] ?? '';
    }, SETUP_TIMEOUT_MS);

    afterAll(() => {
      try {
        s3?.destroy();
        compose(['--profile', 'core', 'down', '-v', '--remove-orphans']);
      } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, SETUP_TIMEOUT_MS);

    it('writes the four keys to security.toml, mode 600, owner seaweed', () => {
      const out = must(
        compose([
          '--profile',
          'core',
          'exec',
          '-T',
          'seaweedfs',
          'sh',
          '-c',
          `stat -c '%a %U' /etc/seaweedfs/security.toml; grep -c '^key = "[0-9a-f]\\{64\\}"$' /etc/seaweedfs/security.toml`,
        ]),
        'stat',
      );
      expect(out.trim().split('\n')).toEqual(['600 seaweed', '4']);
    });

    it('listens on the network only on the S3 ports (8333 and its gRPC 18333)', () => {
      const out = must(
        compose(['--profile', 'core', 'exec', '-T', 'seaweedfs', 'netstat', '-tln']),
        'netstat',
      );
      const local = out
        .split('\n')
        .filter((l) => l.includes('LISTEN'))
        .map((l) => l.trim().split(/\s+/)[3]!);
      // 127.0.0.11 is Docker's own DNS resolver in the namespace.
      const open = local.filter(
        (a) => !a.startsWith('127.0.0.1:') && !a.startsWith('127.0.0.11:') && !a.startsWith('::1:'),
      );
      // A port may listen on tcp and tcp6: count each port once.
      expect([...new Set(open.map((a) => a.split(':').at(-1)))].sort()).toEqual(['18333', '8333']);
      for (const port of ['8888', '18888', '9333', '19333', '8080', '18080']) {
        expect(local).toContain(`127.0.0.1:${port}`);
      }
    });

    it('found the object and its file ID', () => {
      expect(fileId).toMatch(/^[0-9]+,[0-9a-f]+$/);
    });

    it('refuses the filer GET and DELETE, a direct volume read and the master from another container', () => {
      const r = probe(
        [
          // Positive control: the probe has its tools and reaches SeaweedFS's S3 API.
          `command -v curl weed timeout >/dev/null; echo "tools=$?"`,
          `curl -s -o /dev/null --max-time 5 http://seaweedfs:8333/healthz; echo "s3=$?"`,
          `curl -s -o /dev/null --max-time 5 http://seaweedfs:8888/buckets/${BUCKET}/${KEY}; echo "filer_get=$?"`,
          `curl -s -o /dev/null --max-time 5 -X DELETE http://seaweedfs:8888/buckets/${BUCKET}/${KEY}?recursive=true; echo "filer_delete=$?"`,
          `curl -s -o /dev/null --max-time 5 http://seaweedfs:8080/${fileId}; echo "volume_get=$?"`,
          `curl -s -o /dev/null --max-time 5 -X DELETE http://seaweedfs:8080/${fileId}; echo "volume_delete=$?"`,
          `curl -s -o /dev/null --max-time 5 http://seaweedfs:9333/dir/status; echo "master=$?"`,
          `curl -s -o /dev/null --max-time 5 http://seaweedfs:8181/; echo "iceberg=$?"`,
          `curl -s -o /dev/null --max-time 5 http://seaweedfs:9101/; echo "lance=$?"`,
        ].join('; '),
      );
      expect(r.stdout).toMatch(/^tools=0$/m);
      expect(r.stdout).toMatch(/^s3=0$/m);
      // curl exit 7: could not connect.
      for (const name of [
        'filer_get',
        'filer_delete',
        'volume_get',
        'volume_delete',
        'master',
        'iceberg',
        'lance',
      ]) {
        expect(r.stdout, name).toMatch(new RegExp(`^${name}=7$`, 'm'));
      }
    });

    it('a weed shell from another container cannot reach the master or the filer', () => {
      // `weed shell` exits 0 even when its commands fail, so the proof is what it shows: nothing.
      // The next test checks that the version is still there after the `fs.rm`.
      const r = probe(
        `printf 'fs.ls /buckets/${BUCKET}/a12\\nfs.rm -r /buckets/${BUCKET}/a12\\n' | timeout 25 weed shell -master=seaweedfs:9333 2>&1; echo "shell_done"`,
      );
      expect(r.stdout).toContain('shell_done');
      expect(r.stdout).not.toContain('probe.txt');

      // Positive control: the same listing from inside the container's network namespace shows
      // the object, so an empty answer above means "not reachable", not a broken probe.
      const id = must(compose(['--profile', 'core', 'ps', '-q', 'seaweedfs']), 'ps').trim();
      const inside = run(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          `container:${id}`,
          '--entrypoint',
          '/bin/sh',
          image,
          '-c',
          `printf 'fs.ls /buckets/${BUCKET}/a12\\n' | timeout 25 weed shell -master=127.0.0.1:9333 2>&1`,
        ],
        '',
        90_000,
      );
      expect(inside.stdout).toContain('probe.txt');
    });

    it('the S3 gRPC port offers only the reviewed services (a new one needs a review)', () => {
      const r = run(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          network,
          GRPCURL,
          '-plaintext',
          '-max-time',
          '20',
          'seaweedfs:18333',
          'list',
        ],
        '',
        90_000,
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split('\n').sort()).toEqual([
        'grpc.reflection.v1.ServerReflection',
        'grpc.reflection.v1alpha.ServerReflection',
        'messaging_pb.SeaweedS3IamCache',
        's3_lifecycle_pb.SeaweedS3LifecycleInternal',
      ]);
    });

    it('refuses the unauthenticated IAM and lifecycle calls on the S3 gRPC port (QUESTIONS #245)', async () => {
      const accessKey = `A12PROBE${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      const secretKey = crypto.randomBytes(24).toString('hex');
      const put = grpc('messaging_pb.SeaweedS3IamCache/PutIdentity', {
        identity: {
          name: 'a12-probe',
          credentials: [{ access_key: accessKey, secret_key: secretKey, status: 'Active' }],
          actions: ['Admin'],
        },
      });
      expect(put.status).not.toBe(0);
      expect(put.stdout + put.stderr).toContain('Unauthenticated');

      // Every other method of the IAM cache service, read or write, is refused the same way.
      for (const method of [
        'RemoveIdentity',
        'PutPolicy',
        'DeletePolicy',
        'GetPolicy',
        'ListPolicies',
        'PutGroup',
        'RemoveGroup',
      ]) {
        const other = grpc(`messaging_pb.SeaweedS3IamCache/${method}`, {});
        expect(other.status, method).not.toBe(0);
        expect(other.stdout + other.stderr, method).toContain('Unauthenticated');
      }

      const del = grpc('s3_lifecycle_pb.SeaweedS3LifecycleInternal/LifecycleDelete', {
        bucket: BUCKET,
        object_path: KEY,
        version_id: versionId,
      });
      expect(del.status).not.toBe(0);
      expect(del.stdout + del.stderr).toContain('Unauthenticated');

      const injected = new S3Client({
        endpoint: s3Url,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      });
      try {
        await expect(
          injected.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY })),
        ).rejects.toThrow();
      } finally {
        injected.destroy();
      }
    });

    it('keeps the locked version and its legal hold after every attempt', async () => {
      const versions = await s3!.send(
        new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: KEY }),
      );
      expect((versions.Versions ?? []).map((v) => v.VersionId)).toContain(versionId);
      expect(versions.DeleteMarkers ?? []).toEqual([]);
      const hold = await s3!.send(
        new GetObjectLegalHoldCommand({ Bucket: BUCKET, Key: KEY, VersionId: versionId }),
      );
      expect(hold.LegalHold?.Status).toBe('ON');
      const got = await s3!.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
      expect(await got.Body!.transformToString()).toBe(body);
    });

    it('the filer refuses a read without a token even inside the container (read key loaded)', () => {
      const out = must(
        compose([
          '--profile',
          'core',
          'exec',
          '-T',
          'seaweedfs',
          'sh',
          '-c',
          `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8888/buckets/${BUCKET}/${KEY}; echo; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/${fileId}`,
        ]),
        'inside read',
      );
      expect(out.trim().split('\n')).toEqual(['401', '401']);
    });

    it('admin work through docker compose exec still works (weed shell with the keys)', async () => {
      const out = must(weedShell('s3.bucket.list\n'), 'weed shell');
      expect(out).toContain(BUCKET);
      // An IAM change needs the filer key: add a read-only identity the way bootstrap.sh does
      // (keys on stdin, output discarded: `s3.configure` prints every key), then use it.
      const accessKey = `A12ADMIN${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      const secretKey = crypto.randomBytes(24).toString('hex');
      const applied = compose(
        [
          '--profile',
          'core',
          'exec',
          '-T',
          'seaweedfs',
          'sh',
          '-c',
          'weed shell -master=127.0.0.1:9333 >/dev/null 2>&1',
        ],
        `s3.configure -user=a12-admin-probe -access_key=${accessKey} -secret_key=${secretKey} -actions=Read:${BUCKET}/a12/* -apply\n`,
      );
      expect(applied.status).toBe(0);
      const reader = new S3Client({
        endpoint: s3Url,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      });
      try {
        // The S3 gateway picks up the change asynchronously.
        let text = '';
        for (let attempt = 0; attempt < 20 && text === ''; attempt++) {
          try {
            const got = await reader.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
            text = await got.Body!.transformToString();
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        expect(text).toBe(body);
      } finally {
        reader.destroy();
      }
    });

    describe('start.sh fails closed: no keys, no SeaweedFS', () => {
      const startSh = path.join(deployDir, 'seaweedfs/start.sh');
      const start = (extra: string[]): Result =>
        run(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            ...extra,
            '-v',
            `${startSh}:/scripts/start.sh:ro`,
            '--entrypoint',
            '/bin/sh',
            image,
            '/scripts/start.sh',
            'server',
            '-dir=/data',
            '-ip=127.0.0.1',
          ],
          '',
          60_000,
        );
      const notStarted = (r: Result): void => {
        expect(r.status).not.toBe(0);
        expect(r.stdout + r.stderr).not.toMatch(/Start Seaweed/);
      };

      it('when /dev/urandom gives no bytes', () => {
        const r = start(['-v', '/dev/null:/dev/urandom:ro']);
        notStarted(r);
        expect(r.stderr).toContain('seaweedfs-start: could not make');
      });

      it('when the file cannot be written', () => {
        const r = start(['--read-only', '--tmpfs', '/data']);
        notStarted(r);
        expect(r.stderr).toContain('seaweedfs-start: could not write');
      });

      it('when it does not start as root', () => {
        const r = start(['--user', '1000:1000']);
        notStarted(r);
        expect(r.stderr).toContain('seaweedfs-start: must start as root');
      });
    });
  },
);
