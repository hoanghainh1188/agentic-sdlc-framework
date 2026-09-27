// B06: settings of the worker process (design/ADR-M27 §2.5). No secret from the environment.
import { describe, expect, it } from 'vitest';

import { loadSettings, SettingsError } from '../../apps/worker/src/settings.js';

describe('worker settings', () => {
  it('has defaults for the Compose deployment', () => {
    expect(loadSettings({})).toEqual({
      database: {
        kind: 'openbao',
        host: 'postgres',
        port: 5432,
        name: 'platform',
        secretPath: 'worker/database',
      },
      githubApiUrl: 'https://api.github.com',
      tickMs: 1000,
      maxConcurrentPolls: 4,
      maxReplyAttempts: 5,
      maxEventAttempts: 3,
      heartbeatFile: '/tmp/sdlc-worker.heartbeat',
      escalationTickMs: 15_000,
      escalationBatch: 100,
      temporal: { address: 'temporal:7233', namespace: 'default' },
      reconcileMs: 600_000,
      reconcileBatch: 500,
      workflowBundle: null,
    });
  });

  it('B07: the intent workflow can be turned off in development mode only', () => {
    const dev = { SDLC_WORKER_DEV_MODE: '1', SDLC_WORKER_DEV_DB_URL: 'postgres://x/y' };
    expect(loadSettings({ ...dev, SDLC_WORKER_TEMPORAL_ADDRESS: 'off' }).temporal).toBeNull();
    expect(() => loadSettings({ SDLC_WORKER_TEMPORAL_ADDRESS: 'off' })).toThrow(
      expect.objectContaining({ key: 'worker.settings.temporal_off_in_production' }),
    );
    expect(
      loadSettings({ SDLC_WORKER_WORKFLOW_BUNDLE: '/app/dist/workflow-bundle.js' }).workflowBundle,
    ).toBe('/app/dist/workflow-bundle.js');
  });

  it.each([
    ['SDLC_WORKER_DB_SECRET_PATH', 'api/database'],
    ['SDLC_WORKER_GITHUB_API_URL', 'http://api.github.com'],
    ['SDLC_WORKER_TICK_MS', '10'],
    ['SDLC_WORKER_MAX_CONCURRENT_POLLS', '0'],
    ['SDLC_WORKER_DB_PORT', 'x'],
    ['SDLC_WORKER_MAX_EVENT_ATTEMPTS', '0'],
    ['SDLC_WORKER_ESCALATION_TICK_MS', '10'],
    ['SDLC_WORKER_ESCALATION_BATCH', '0'],
    ['SDLC_WORKER_TEMPORAL_ADDRESS', 'temporal'],
    ['SDLC_WORKER_TEMPORAL_NAMESPACE', 'a/b'],
    ['SDLC_WORKER_RECONCILE_MS', '100'],
    ['SDLC_WORKER_RECONCILE_BATCH', '0'],
    ['SDLC_WORKER_WORKFLOW_BUNDLE', 'relative.js'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => loadSettings({ [name]: value })).toThrow(
      expect.objectContaining({ key: 'worker.settings.invalid', setting: name }),
    );
  });

  it('dev mode needs a URL and is refused in production', () => {
    expect(() => loadSettings({ SDLC_WORKER_DEV_MODE: '1' })).toThrow(SettingsError);
    expect(
      loadSettings({ SDLC_WORKER_DEV_MODE: '1', SDLC_WORKER_DEV_DB_URL: 'postgres://x/y' })
        .database,
    ).toEqual({ kind: 'dev_url', url: 'postgres://x/y' });
    expect(() =>
      loadSettings({
        SDLC_WORKER_DEV_MODE: '1',
        SDLC_WORKER_DEV_DB_URL: 'postgres://x/y',
        NODE_ENV: 'production',
      }),
    ).toThrow(expect.objectContaining({ key: 'worker.settings.dev_mode_in_production' }));
  });
});
