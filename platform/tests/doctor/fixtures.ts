// Facts of a healthy deployment for the `pnpm doctor` tests (D-08 V07 AC4): each test changes the
// part it checks. No real host, no Docker.
import fs from 'node:fs';
import path from 'node:path';

import { CORE_SERVICES, JOBS } from '../../deploy/doctor/src/checks/stack.js';
import { manifestPermissions } from '../../deploy/doctor/src/github-permissions.js';
import type { OperatorFacts, ServiceState } from '../../deploy/doctor/src/types.js';
import { repoRoot } from '../workspace/helpers';

export const NOW = new Date('2026-10-12T00:00:00.000Z');
export const GIB = 1024 ** 3;
const DAY = 86_400_000;

export const MANIFEST = manifestPermissions(
  fs.readFileSync(path.join(repoRoot(), 'platform/deploy/github-app/manifest.json'), 'utf8'),
);

export const inDays = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

export function service(name: string, extra: Partial<ServiceState> = {}): ServiceState {
  return { service: name, state: 'running', health: 'healthy', exitCode: 0, ...extra };
}

export const RUNNING: ServiceState[] = [
  ...CORE_SERVICES.map((s) => service(s)),
  ...['sdlc-api', 'sdlc-worker', 'sdlc-runner', 'litellm-agent'].map((s) => service(s)),
  ...JOBS.filter((j) => j !== 'backup-agent').map((j) =>
    service(j, { state: 'exited', health: '', exitCode: 0 }),
  ),
];

export function healthyFacts(overrides: Partial<OperatorFacts> = {}): OperatorFacts {
  return {
    now: NOW,
    envFile: {
      path: '/srv/sdlc/.env',
      exists: true,
      mode: 0o100600,
      facts: {
        values: { COMPOSE_PROJECT_NAME: 'sdlc', SDLC_OPENBAO_TLS_DIR: '/srv/sdlc/tls' },
        secrets: { PLATFORM_DB_PASSWORD: 'set', VALKEY_PASSWORD: 'set' },
      },
    },
    docker: { serverVersion: '29.8.2', composeVersion: '2.30.1', memoryBytes: 16 * GIB },
    disk: [{ path: '/srv/sdlc', freeBytes: 100 * GIB }],
    services: RUNNING,
    openbao: 'unsealed',
    tls: {
      dir: '/srv/sdlc/tls',
      missing: [],
      certs: [
        { name: 'ca', notAfter: inDays(1500) },
        { name: 'server', notAfter: inDays(300) },
      ],
    },
    migrations: { expected: ['0001-a', '0002-b'], applied: ['0001-a', '0002-b'] },
    approles: [
      { service: 'sdlc-api', credentials: 'api-credentials', state: 'ok', ageDays: 10 },
      { service: 'sdlc-worker', credentials: 'worker-credentials', state: 'ok', ageDays: 10 },
    ],
    logs: { events: [], started: ['sdlc-api', 'sdlc-worker'] },
    valkey: { usedBytes: 10 * 1024 ** 2, maxBytes: 256 * 1024 ** 2 },
    github: {
      ok: true,
      app: { permissions: { ...MANIFEST } },
      repos: [
        { repo: 'acme/shop', installed: true, selection: 'selected', permissions: { ...MANIFEST } },
      ],
    },
    manifest: MANIFEST,
    projects: [
      {
        project: 'acme/shop',
        image: `ghcr.io/openhands/agent-server:1@sha256:${'a'.repeat(64)}`,
        present: true,
      },
    ],
    imagesMode: 'local',
    ...overrides,
  };
}
