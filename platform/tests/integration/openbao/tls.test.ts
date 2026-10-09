// Live test of TLS on OpenBao's listener 8200 (task A10, design/ADR-M63, QUESTIONS #20). Needs
// Docker and OpenSSL 3 or later. Skipped unless SDLC_OPENBAO_TEST=1. Run with: pnpm test:openbao
//
// Only OpenBao and its job openbao-tls-init run, in an own throw-away Compose project. Nothing is
// initialised: the checks are about the transport. Certificates are throw-away test certificates.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deployDir } from '../../deploy/compose';
import { baoClientArgs, containerIp, isolateEnv, openbaoImage } from '../throwaway-compose';

const enabled = process.env.SDLC_OPENBAO_TEST === '1';
const PORT_OFFSET = 28000;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!enabled)('OpenBao TLS on 8200 (live)', { timeout: TEST_TIMEOUT_MS }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tls-it-'));
  const envFile = path.join(tmp, 'it.env');
  const project = `sdlctls${process.pid}`;
  const network = `${project}-net`;
  // Subnet range of this file: 172.31.10–49 (the other live test files use 172.30.*).
  const subnet = `172.31.${10 + (process.pid % 40)}.0/24`;
  const tlsScript = path.join(deployDir, 'openbao/tls.sh');
  let image = '';

  const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): Result => {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      env: { ...process.env, SDLC_ENV_FILE: envFile, ...env },
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const ok = (r: Result, what: string): Result => {
    if (r.status !== 0)
      throw new Error(`${what} failed (exit ${r.status}): ${r.stderr}${r.stdout}`);
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
  const tlsDir = (): string =>
    /^SDLC_OPENBAO_TLS_DIR=(.+)$/m.exec(fs.readFileSync(envFile, 'utf8'))![1]!;
  // `bao status` from a one-shot container on the network, with the given extra docker options.
  const baoStatus = (extra: string[]): Result =>
    run('docker', [
      'run',
      '--rm',
      '--network',
      network,
      ...extra,
      '--entrypoint',
      'bao',
      image,
      'status',
      '-format=json',
    ]);
  const startedAt = (): string =>
    ok(
      run('docker', ['inspect', '-f', '{{.State.StartedAt}}', `${project}-openbao-1`]),
      'inspect',
    ).stdout.trim();

  beforeAll(() => {
    image = openbaoImage();
    ok(run(path.join(deployDir, 'scripts/init-env.sh'), [envFile]), 'init-env');
    const gateway = subnet.replace(/\.0\/24$/, '.1');
    fs.writeFileSync(
      envFile,
      isolateEnv(fs.readFileSync(envFile, 'utf8'), {
        project,
        subnet,
        gateway,
        portOffset: PORT_OFFSET,
      }),
      { mode: 0o600 },
    );
    ok(compose('up', '-d', '--wait', 'openbao'), 'compose up openbao');
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    compose('down', '--volumes', '--remove-orphans');
    fs.rmSync(tmp, { recursive: true, force: true });
  }, SETUP_TIMEOUT_MS);

  it('copies the files with the right owner and modes; OpenBao is healthy over TLS', () => {
    const files = ok(
      compose(
        'exec',
        '-T',
        'openbao',
        'sh',
        '-c',
        'stat -c "%n %u %a" /openbao/tls/* /openbao/ca/*',
      ),
      'stat',
    ).stdout;
    expect(files).toContain('/openbao/tls/server-key.pem 100 600');
    expect(files).toContain('/openbao/tls/server.pem 100 644');
    expect(files).toContain('/openbao/ca/ca.pem 0 644');
    expect(compose('ps', '--format', '{{.Health}}', 'openbao').stdout.trim()).toBe('healthy');
    expect(
      compose('ps', '-a', '--format', '{{.State}} {{.ExitCode}}', 'openbao-tls-init').stdout.trim(),
    ).toBe('exited 0');
  });

  it('answers a client that verifies the CA, and refuses plain HTTP', () => {
    const good = baoStatus(baoClientArgs(network));
    expect(good.status).toBe(2); // uninitialised and sealed: an answer, not an error
    expect(JSON.parse(good.stdout)).toMatchObject({ initialized: false, sealed: true });

    const plain = run('docker', [
      'run',
      '--rm',
      '--network',
      network,
      '--entrypoint',
      'wget',
      image,
      '-q',
      '-O',
      '-',
      'http://openbao:8200/v1/sys/seal-status',
    ]);
    expect(plain.status).not.toBe(0);
    expect(plain.stdout).not.toContain('"sealed"');
  });

  it('a client with another CA, or that reaches OpenBao by its IP, is refused', () => {
    // Another throw-away CA, in its own folder.
    const otherDir = fs.mkdtempSync(path.join(tmp, 'other-'));
    const otherEnv = path.join(otherDir, 'other.env');
    fs.writeFileSync(otherEnv, 'SDLC_OPENBAO_TLS_DIR=\n', { mode: 0o600 });
    ok(run(tlsScript, ['dev', otherEnv]), 'tls.sh dev (other CA)');
    const otherCa = path.join(otherDir, 'openbao-tls', 'ca.pem');
    expect(fs.readFileSync(otherCa, 'utf8')).not.toBe(
      fs.readFileSync(path.join(tlsDir(), 'ca.pem'), 'utf8'),
    );
    const wrongCa = baoStatus([
      '-v',
      `${otherCa}:/other/ca.pem:ro`,
      '-e',
      'BAO_ADDR=https://openbao:8200',
      '-e',
      'BAO_CACERT=/other/ca.pem',
    ]);
    expect(wrongCa.status).toBe(1);
    expect(wrongCa.stderr).toMatch(/certificate/i);

    const ip = containerIp(`${project}-openbao-1`, network);
    const byIp = baoStatus([...baoClientArgs(network), '-e', `BAO_ADDR=https://${ip}:8200`]);
    expect(byIp.status).toBe(1);
    expect(byIp.stderr).toMatch(/certificate/i);
  });

  it('reload: a new certificate from a new CA, read without a restart (OpenBao stays up)', () => {
    const before = startedAt();
    const caDir = path.join(tmp, 'offline-ca');
    ok(run(tlsScript, ['ca', caDir]), 'tls.sh ca');
    ok(run(tlsScript, ['server', caDir]), 'tls.sh server');
    expect(fs.readFileSync(path.join(tlsDir(), 'ca.pem'), 'utf8')).toBe(
      fs.readFileSync(path.join(caDir, 'ca.pem'), 'utf8'),
    );
    ok(run(tlsScript, ['reload']), 'tls.sh reload');

    // The volume openbao-ca now holds the new CA, and OpenBao serves the new certificate.
    const fresh = baoStatus(baoClientArgs(network));
    expect(fresh.status).toBe(2);
    expect(startedAt()).toBe(before);
    ok(run(tlsScript, ['check']), 'tls.sh check');
  });

  it('the job fails closed when a file is missing, and OpenBao does not start', () => {
    // A fresh folder without the key (renaming in the mounted folder can meet a stale cache of
    // Docker Desktop's file sharing). The shell's value of the variable wins over the env file.
    const partial = fs.mkdtempSync(path.join(tmp, 'partial-'));
    for (const f of ['ca.pem', 'server.pem'])
      fs.copyFileSync(path.join(tlsDir(), f), path.join(partial, f));
    const job = run(
      'docker',
      [
        'compose',
        '-f',
        path.join(deployDir, 'docker-compose.yml'),
        '--env-file',
        envFile,
        '--profile',
        'core',
        'run',
        '--rm',
        '--no-deps',
        'openbao-tls-init',
      ],
      { SDLC_OPENBAO_TLS_DIR: partial },
    );
    expect(job.status).not.toBe(0);
    expect(job.stderr + job.stdout).toMatch(/server-key\.pem missing in SDLC_OPENBAO_TLS_DIR/);
  });
});
