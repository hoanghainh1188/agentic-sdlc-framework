// D-08 task A10 (design/ADR-M63, QUESTIONS #20): TLS on OpenBao's listener 8200 everywhere
// (development machines, CI and the server). Static checks of the compose file and of
// openbao/tls.sh; the live checks are in platform/tests/integration/openbao/tls.test.ts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { deployDir, loadCompose, readDeployFile, root } from './compose';

const compose = loadCompose();
const services = Object.entries(compose.services);
const TLS = path.join(deployDir, 'openbao/tls.sh');
const CA_VOLUME = 'openbao-ca';

describe('OpenBao clients in Compose (A10)', () => {
  it('no service talks to OpenBao over plain HTTP', () => {
    for (const [name, s] of services) {
      const env = s.environment ?? {};
      expect(env.SDLC_OPENBAO_ALLOW_PLAINTEXT, name).toBeUndefined();
      for (const key of ['SDLC_OPENBAO_ADDR', 'BAO_ADDR']) {
        if (env[key] !== undefined) expect(env[key], `${name} ${key}`).toMatch(/^https:\/\//);
      }
    }
    expect(readDeployFile('docker-compose.yml')).not.toMatch(
      /http:\/\/(openbao|127\.0\.0\.1):8200/,
    );
  });

  it('every client verifies the CA, mounted read-only from the volume openbao-ca', () => {
    const clients = services.filter(
      ([, s]) => s.environment?.SDLC_OPENBAO_ADDR ?? s.environment?.BAO_ADDR,
    );
    expect(clients.map(([name]) => name).sort()).toEqual([
      'litellm-agent',
      'openbao',
      'sdlc-api',
      'sdlc-runner',
      'sdlc-worker',
    ]);
    for (const [name, s] of clients) {
      const env = s.environment ?? {};
      const ca = env.SDLC_OPENBAO_CA_CERT_FILE ?? env.BAO_CACERT;
      expect(ca, name).toMatch(/\/ca\.pem$/);
      const mount = (s.volumes ?? []).find((v) => v.startsWith(`${CA_VOLUME}:`));
      expect(mount, name).toBe(`${CA_VOLUME}:${path.posix.dirname(ca!)}:ro`);
    }
  });

  it('openbao-tls-init copies the files without a network, and OpenBao waits for it', () => {
    const job = compose.services['openbao-tls-init']!;
    expect(job.image).toBe(compose.services.openbao!.image);
    expect(job.restart).toBe('no');
    expect((job as { network_mode?: string }).network_mode).toBe('none');
    expect(job.volumes).toEqual([
      '${SDLC_OPENBAO_TLS_DIR:?set SDLC_OPENBAO_TLS_DIR in .env (openbao/tls.sh dev)}:/src:ro',
      'openbao-tls:/tls',
      `${CA_VOLUME}:/ca`,
    ]);
    const script = String(job.command);
    expect(script).toMatch(/chmod 0600 \/tls\/server-key\.pem\.new/);
    expect(script).not.toMatch(/ca-key/);
    expect(compose.services.openbao!.depends_on).toEqual({
      'openbao-tls-init': { condition: 'service_completed_successfully' },
    });
    expect(compose.services.openbao!.volumes).toEqual(
      expect.arrayContaining(['openbao-tls:/openbao/tls:ro', `${CA_VOLUME}:/openbao/ca:ro`]),
    );
  });

  it('the healthcheck verifies the certificate (bao status), never a plain URL', () => {
    const test = String(compose.services.openbao!.healthcheck?.test);
    expect(test).toMatch(/bao status/);
    expect(test).not.toMatch(/http:/);
  });
});

describe('openbao/tls.sh (A10)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tls-')));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(TLS, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  const openssl = (args: string[]) => spawnSync('openssl', args, { encoding: 'utf8' });

  it('dev: a throw-away CA and a certificate for openbao and 127.0.0.1; the CA key is gone', () => {
    const envFile = path.join(tmp, 'dev.env');
    fs.writeFileSync(envFile, 'A=1\nSDLC_OPENBAO_TLS_DIR=\n', { mode: 0o600 });
    const first = run(['dev', envFile]);
    expect(first.status, first.stderr).toBe(0);
    const dir = path.join(tmp, 'openbao-tls');
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`SDLC_OPENBAO_TLS_DIR=${dir}\n`);
    expect(fs.readdirSync(dir).sort()).toEqual(['ca.pem', 'server-key.pem', 'server.pem']);
    expect(fs.statSync(path.join(dir, 'server-key.pem')).mode & 0o777).toBe(0o600);
    const san = openssl([
      'x509',
      '-in',
      path.join(dir, 'server.pem'),
      '-noout',
      '-ext',
      'subjectAltName',
    ]);
    expect(san.stdout).toMatch(/DNS:openbao, IP Address:127\.0\.0\.1/);
    const verify = openssl([
      'verify',
      '-CAfile',
      path.join(dir, 'ca.pem'),
      path.join(dir, 'server.pem'),
    ]);
    expect(verify.status, verify.stderr).toBe(0);
    expect(run(['check'], { SDLC_ENV_FILE: envFile }).status).toBe(0);
    // A second run keeps the certificate.
    const before = fs.readFileSync(path.join(dir, 'server.pem'), 'utf8');
    expect(run(['dev', envFile]).status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'server.pem'), 'utf8')).toBe(before);
  });

  it('ca and server: a 5-year CA outside the repository, a 1-year certificate', () => {
    const envFile = path.join(tmp, 'server.env');
    const dir = path.join(tmp, 'server-tls');
    fs.writeFileSync(envFile, `SDLC_OPENBAO_TLS_DIR=${dir}\n`, { mode: 0o600 });
    const caDir = path.join(tmp, 'offline-ca');
    expect(run(['ca', caDir]).status).toBe(0);
    expect(fs.statSync(path.join(caDir, 'ca-key.pem')).mode & 0o777).toBe(0o600);
    expect(run(['ca', caDir]).status).toBe(1); // never overwrites a CA
    expect(run(['server', caDir], { SDLC_ENV_FILE: envFile }).status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'ca-key.pem'))).toBe(false);
    const days = (file: string, d: number) =>
      openssl(['x509', '-in', file, '-noout', '-checkend', String(d * 86400)]).status === 0;
    expect(days(path.join(dir, 'server.pem'), 360)).toBe(true);
    expect(days(path.join(dir, 'server.pem'), 370)).toBe(false);
    expect(days(path.join(caDir, 'ca.pem'), 1820)).toBe(true);
    expect(run(['check'], { SDLC_ENV_FILE: envFile }).status).toBe(0);
  });

  it('refuses a CA folder inside the repository, and check fails without a certificate', () => {
    const inside = run(['ca', path.join(root, 'platform/deploy/openbao-ca-test')]);
    expect(inside.status).toBe(1);
    expect(inside.stderr).toMatch(/outside the repository/);
    expect(fs.existsSync(path.join(root, 'platform/deploy/openbao-ca-test'))).toBe(false);
    const envFile = path.join(tmp, 'empty.env');
    fs.writeFileSync(envFile, `SDLC_OPENBAO_TLS_DIR=${path.join(tmp, 'nothing')}\n`);
    expect(run(['check'], { SDLC_ENV_FILE: envFile }).status).toBe(1);
  });
});
