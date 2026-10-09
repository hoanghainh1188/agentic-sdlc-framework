// Live test of the backup and the restore drill (task A10 PR 2, AC2 and AC3, design/ADR-M63 §5,
// runbook T11 sections 6 and 7). Needs Docker, age and OpenSSL 3 or later. Skipped unless
// SDLC_BACKUP_TEST=1. Run with: pnpm test:backup
//
// Stack A (PostgreSQL, OpenBao, SeaweedFS) gets data: a KV secret, a Transit signature, a database
// row, an S3 object. `pnpm backup` writes an encrypted backup; the stack is then lost (volumes,
// env file and TLS folder removed). A tampered copy is refused; `pnpm restore` brings the real one
// back, two ORIGINAL key shares unseal OpenBao, and every piece of data is checked.
// Own throw-away Compose project. Key shares, tokens, passwords and the age key are THROW-AWAY TEST
// KEYS: kept in this process or its temporary folder, never printed, never in an assertion message.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir, parseEnvFile } from '../../deploy/compose';
import { isolateEnv } from '../throwaway-compose';

const enabled = process.env.SDLC_BACKUP_TEST === '1';
const PORT_OFFSET = 29000;
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const TEST_TIMEOUT_MS = 15 * 60 * 1000;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!enabled)('backup and restore drill (live)', { timeout: TEST_TIMEOUT_MS }, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-backup-it-')));
  const stackDir = path.join(tmp, 'stack');
  const envFile = path.join(stackDir, 'it.env');
  const backups = path.join(tmp, 'backups');
  const identity = path.join(tmp, 'age-identity.txt');
  const recipients = path.join(tmp, 'age-recipients.txt');
  const project = `sdlcbak${process.pid}`;
  // Subnet range of this file: 172.31.50–89 (tls.test.ts uses 172.31.10–49).
  const subnet = `172.31.${50 + (process.pid % 40)}.0/24`;
  const bootstrap = path.join(deployDir, 'openbao/bootstrap.sh');

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
      maxBuffer: 64 * 1024 * 1024,
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
      '--profile',
      'core',
      ...args,
    ]);
  const withRoot = (script: string, input = ''): Result =>
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
        'exec',
        '-T',
        'openbao',
        'sh',
        '-c',
        `IFS= read -r BAO_TOKEN && export BAO_TOKEN && ${script}`,
      ],
      `${rootToken}\n${input}`,
    );
  const psql = (sql: string): Result =>
    compose(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'platform',
      '-c',
      sql,
    );
  const s3 = (): S3Client => {
    const env = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
    return new S3Client({
      endpoint: `http://127.0.0.1:${env.get('SEAWEEDFS_S3_HOST_PORT')!}`,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: keep(env.get('SEAWEEDFS_S3_ACCESS_KEY')!),
        secretAccessKey: keep(env.get('SEAWEEDFS_S3_SECRET_KEY')!),
      },
    });
  };

  let shares: string[] = [];
  let rootToken = '';
  const kvValue = keep(crypto.randomBytes(18).toString('hex'));
  const dbValue = keep(`probe-${crypto.randomBytes(9).toString('hex')}`);
  const s3Value = keep(`object-${crypto.randomBytes(9).toString('hex')}`);
  const signedInput = Buffer.from(`run contract ${process.pid}`).toString('base64');
  let signature = '';
  let backupFolder = '';

  beforeAll(async () => {
    fs.mkdirSync(stackDir);
    fs.mkdirSync(backups);
    ok(run('age-keygen', ['-o', identity]), 'age-keygen');
    fs.writeFileSync(recipients, ok(run('age-keygen', ['-y', identity]), 'age-keygen -y').stdout);

    ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
    let text = isolateEnv(fs.readFileSync(envFile, 'utf8'), {
      project,
      subnet,
      gateway: subnet.replace(/0\/24$/, '1'),
      portOffset: PORT_OFFSET,
    });
    text = text
      .replace(/^SDLC_BACKUP_DIR=.*$/m, `SDLC_BACKUP_DIR=${backups}`)
      .replace(/^SDLC_BACKUP_AGE_RECIPIENTS=.*$/m, `SDLC_BACKUP_AGE_RECIPIENTS=${recipients}`);
    fs.writeFileSync(envFile, text, { mode: 0o600 });
    for (const line of text.split('\n')) {
      if (/_(PASSWORD|KEY|SECRET)[A-Z_]*=/.test(line)) keep(line.slice(line.indexOf('=') + 1));
    }

    ok(compose('up', '-d', '--wait', 'postgres', 'openbao', 'seaweedfs'), 'compose up');
    const init = ok(
      run(bootstrap, ['init', '--stdout-not-tty'], '', { SDLC_OPENBAO_TEST: '1' }),
      'init',
    );
    shares = [...init.stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => keep(m[1]!));
    rootToken = keep(/^Initial Root Token: (\S+)$/m.exec(init.stdout)?.[1] ?? '');
    ok(run(bootstrap, ['unseal'], `${shares[0]}\n${shares[1]}\n`), 'unseal');
    ok(run(bootstrap, ['configure', '--keep-token'], `${rootToken}\n`), 'configure');
    ok(run(bootstrap, ['backup-credentials'], `${rootToken}\n`), 'backup-credentials');

    // The data the restore must bring back.
    ok(withRoot('bao kv put -mount=kv backup-test/probe value=- >/dev/null', kvValue), 'kv put');
    signature = ok(
      withRoot(`bao write -field=signature transit/sign/run-contract input=${signedInput}`),
      'transit sign',
    ).stdout.trim();
    ok(
      psql(`CREATE TABLE backup_probe (v text); INSERT INTO backup_probe VALUES ('${dbValue}')`),
      'psql',
    );
    const client = s3();
    await client.send(new CreateBucketCommand({ Bucket: 'backup-probe' }));
    await client.send(
      new PutObjectCommand({ Bucket: 'backup-probe', Key: 'probe.txt', Body: s3Value }),
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    if (fs.existsSync(envFile))
      compose('--profile', 'backup', 'down', '--volumes', '--remove-orphans');
    fs.rmSync(tmp, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  it('pnpm backup: one complete, encrypted folder, nothing readable in it', () => {
    const r = ok(run('sh', [path.join(deployDir, 'backup/backup.sh')]), 'backup');
    expect(r.stdout).toMatch(/backup: done: /);
    for (const s of secrets) expect(r.stdout + r.stderr).not.toContain(s);
    const folders = fs.readdirSync(backups);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatch(/^\d{8}T\d{6}Z$/);
    backupFolder = path.join(backups, folders[0]!);
    expect(fs.readdirSync(backupFolder).sort()).toEqual([
      'MANIFEST',
      'env.tar.age',
      'openbao-tls.tar.age',
      'openbao.snap.age',
      'postgres.sql.age',
      'volume-openbao-audit.tar.age',
      'volume-seaweedfs-data.tar.age',
    ]);
    const manifest = fs.readFileSync(path.join(backupFolder, 'MANIFEST'), 'utf8');
    expect(manifest).toMatch(/^file postgres\.sql\.age [0-9a-f]{64} \d+$/m);
    // Encrypted: no value of the stack appears in any file, and every part is an age file.
    for (const name of fs.readdirSync(backupFolder)) {
      const bytes = fs.readFileSync(path.join(backupFolder, name));
      for (const s of [kvValue, dbValue, s3Value]) expect(bytes.includes(s), name).toBe(false);
      if (name !== 'MANIFEST')
        expect(bytes.subarray(0, 21).toString(), name).toBe('age-encryption.org/v1');
    }
    // SeaweedFS was started again after the copy.
    expect(compose('ps', '--format', '{{.Health}}', 'seaweedfs').stdout.trim()).toBe('healthy');
  });

  it('the stack is lost; a tampered copy is refused before anything is written', () => {
    ok(compose('--profile', 'backup', 'down', '--volumes', '--remove-orphans'), 'down -v');
    fs.rmSync(envFile);
    fs.rmSync(path.join(stackDir, 'openbao-tls'), { recursive: true });

    const tampered = path.join(tmp, 'tampered');
    fs.cpSync(backupFolder, tampered, { recursive: true });
    const file = path.join(tampered, 'postgres.sql.age');
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    fs.writeFileSync(file, bytes);
    const r = run('sh', [path.join(deployDir, 'backup/restore.sh'), tampered, identity]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/postgres\.sql\.age: SHA-256 differs from MANIFEST/);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it('pnpm restore, then two ORIGINAL shares unseal: every piece of data is back', async () => {
    const r = ok(
      run('sh', [path.join(deployDir, 'backup/restore.sh'), backupFolder, identity]),
      'restore',
    );
    for (const s of secrets) expect(r.stdout + r.stderr).not.toContain(s);
    expect(r.stdout).toMatch(/sealed with the ORIGINAL keys/);
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);

    expect(ok(run(bootstrap, ['status']), 'status').stdout).toMatch(/sealed/);
    ok(run(bootstrap, ['unseal'], `${shares[1]}\n${shares[2]}\n`), 'unseal with original shares');
    expect(ok(run(bootstrap, ['status']), 'status').stdout).toMatch(/unsealed/);

    const kv = ok(withRoot('bao kv get -mount=kv -field=value backup-test/probe'), 'kv get');
    expect(kv.stdout.trim() === kvValue).toBe(true);
    const valid = ok(
      withRoot(
        `bao write -field=valid transit/verify/run-contract input=${signedInput} signature=${signature}`,
      ),
      'transit verify',
    );
    expect(valid.stdout.trim()).toBe('true');
    expect(ok(psql('SELECT v FROM backup_probe'), 'psql').stdout.trim() === dbValue).toBe(true);
    expect(
      ok(
        compose('exec', '-T', 'openbao', 'sh', '-c', 'test -s /openbao/logs/audit.log'),
        'audit log',
      ).status,
    ).toBe(0);

    ok(compose('up', '-d', '--wait', 'seaweedfs'), 'seaweedfs');
    const object = await s3().send(
      new GetObjectCommand({ Bucket: 'backup-probe', Key: 'probe.txt' }),
    );
    expect((await object.Body!.transformToString()) === s3Value).toBe(true);
  });
});
