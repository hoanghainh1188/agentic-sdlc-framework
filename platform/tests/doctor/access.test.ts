// `pnpm doctor`, the team access checks (V09, design/ADR-M67 §2.8): pure functions on facts, plus
// `accessFact` on a real throw-away certificate made by access/tls.sh dev.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { accessChecks, expectedOrigin } from '../../deploy/doctor/src/checks/access.js';
import { accessFact } from '../../deploy/doctor/src/host.js';
import type { AccessFact, CheckResult, OperatorFacts } from '../../deploy/doctor/src/types.js';
import { deployDir } from '../deploy/compose';
import { healthyFacts, inDays, RUNNING, service } from './fixtures.js';

const access = (overrides: Partial<AccessFact> = {}): OperatorFacts => {
  const base = healthyFacts().access!;
  return healthyFacts({ access: { ...base, ...overrides } });
};
const byId = (results: readonly CheckResult[], id: string) => results.filter((r) => r.id === id);
const status = (results: readonly CheckResult[], id: string) =>
  byId(results, id).map((r) => r.status);

describe('pnpm doctor: team access', () => {
  it('healthy: every access line ok', () => {
    const results = accessChecks(healthyFacts());
    expect(results.filter((r) => r.status !== 'ok')).toEqual([]);
    expect(results.map((r) => r.id)).toEqual([
      'access.proxy',
      'access.tls_files',
      'access.tls_expiry',
      'access.tls_expiry',
      'access.tls_names',
      'access.ports',
      'access.public_origin',
      'access.trusted_proxy',
    ]);
  });

  it('off: one ok line, the ports still checked, the rest skipped', () => {
    const facts = access({ configured: false, hostname: null, bindAddr: null });
    const off = { ...facts, services: RUNNING.filter((s) => s.service !== 'sdlc-access') };
    const results = accessChecks(off);
    expect(byId(results, 'access.proxy')[0]?.text.key).toBe('doctor.access.off');
    expect(status(results, 'access.ports')).toEqual(['ok']);
    expect(status(results, 'access.tls_files')).toEqual(['skipped']);
    // A port of another service published beyond this machine always fails.
    const exposed = accessChecks({
      ...off,
      services: [
        ...off.services,
        service('litellm', { published: [{ address: '0.0.0.0', port: 4000 }] }),
      ],
    });
    expect(byId(exposed, 'access.ports')[0]).toMatchObject({
      status: 'failed',
      subject: 'litellm',
    });
  });

  it('the proxy down, unhealthy, on every address or on another address', () => {
    const others = RUNNING.filter((s) => s.service !== 'sdlc-access');
    expect(status(accessChecks({ ...access(), services: others }), 'access.proxy')).toEqual([
      'failed',
    ]);
    const unhealthy = [...others, service('sdlc-access', { health: 'starting' })];
    expect(status(accessChecks({ ...access(), services: unhealthy }), 'access.proxy')).toEqual([
      'warning',
    ]);
    const all = [
      ...others,
      service('sdlc-access', { published: [{ address: '0.0.0.0', port: 8443 }] }),
    ];
    expect(status(accessChecks({ ...access(), services: all }), 'access.ports')).toEqual([
      'warning',
    ]);
    const wrong = [
      ...others,
      service('sdlc-access', { published: [{ address: '10.0.0.9', port: 8443 }] }),
    ];
    expect(status(accessChecks({ ...access(), services: wrong }), 'access.ports')).toEqual([
      'failed',
    ]);
  });

  it('the certificate: missing folder, files, ending, ended, names', () => {
    const tls = healthyFacts().access!.tls;
    expect(
      status(accessChecks(access({ tls: { ...tls, dir: null } })), 'access.tls_files'),
    ).toEqual(['failed']);
    expect(
      status(
        accessChecks(access({ tls: { ...tls, missing: ['server-key.pem'] } })),
        'access.tls_files',
      ),
    ).toEqual(['failed']);
    const soon = { ...tls, certs: [{ name: 'server' as const, notAfter: inDays(10) }] };
    expect(status(accessChecks(access({ tls: soon })), 'access.tls_expiry')).toEqual(['warning']);
    const ended = { ...tls, certs: [{ name: 'server' as const, notAfter: inDays(-1) }] };
    expect(status(accessChecks(access({ tls: ended })), 'access.tls_expiry')).toEqual(['failed']);
    expect(
      status(
        accessChecks(access({ tls: { ...tls, unnamed: ['sdlc.example.internal'] } })),
        'access.tls_names',
      ),
    ).toEqual(['failed']);
    expect(status(accessChecks(access({ hostname: null })), 'access.tls_names')).toEqual([
      'failed',
    ]);
  });

  it('the public origin and the trusted proxy', () => {
    expect(expectedOrigin(healthyFacts().access!)).toBe('https://sdlc.example.internal:8443');
    expect(expectedOrigin({ ...healthyFacts().access!, hostPort: '443' })).toBe(
      'https://sdlc.example.internal',
    );
    expect(
      status(
        accessChecks(access({ publicOrigin: 'http://localhost:8090' })),
        'access.public_origin',
      ),
    ).toEqual(['failed']);
    expect(status(accessChecks(access({ publicOrigin: null })), 'access.public_origin')).toEqual([
      'failed',
    ]);
    expect(
      status(
        accessChecks(access({ publicOrigin: null, webSignIn: 'off' })),
        'access.public_origin',
      ),
    ).toEqual(['ok']);
    expect(status(accessChecks(access({ trustedProxy: null })), 'access.trusted_proxy')).toEqual([
      'failed',
    ]);
  });

  it('no env file: every access line skipped', () => {
    const results = accessChecks(
      healthyFacts({ envFile: { path: '/x', exists: false, mode: null } }),
    );
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(['skipped']));
  });
});

describe('pnpm doctor: accessFact on a real certificate', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-doctor-access-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = path.join(tmp, 'it.env');
  fs.writeFileSync(
    env,
    'SDLC_ACCESS_HOSTNAME=sdlc.example.internal\nSDLC_ACCESS_IPS=192.168.10.5\nSDLC_ACCESS_TLS_DIR=\n',
    { mode: 0o600 },
  );
  const made = spawnSync(path.join(deployDir, 'access/tls.sh'), ['dev'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', SDLC_ENV_FILE: env },
  });

  it('reads the dates and the names, never the key', () => {
    expect(made.status, made.stderr).toBe(0);
    const dir = path.join(tmp, 'access-tls');
    const fact = accessFact({
      SDLC_ACCESS_HOSTNAME: 'sdlc.example.internal',
      SDLC_ACCESS_IPS: '192.168.10.5 192.168.10.9',
      SDLC_ACCESS_TLS_DIR: dir,
    });
    expect(fact.configured).toBe(true);
    expect(fact.tls.missing).toEqual([]);
    expect(fact.tls.certs.every((c) => c.notAfter !== null)).toBe(true);
    expect(fact.tls.unnamed).toEqual(['192.168.10.9']);
    expect(accessFact({}).configured).toBe(false);
  });
});
