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
    });
  });

  it.each([
    ['SDLC_WORKER_DB_SECRET_PATH', 'api/database'],
    ['SDLC_WORKER_GITHUB_API_URL', 'http://api.github.com'],
    ['SDLC_WORKER_TICK_MS', '10'],
    ['SDLC_WORKER_MAX_CONCURRENT_POLLS', '0'],
    ['SDLC_WORKER_DB_PORT', 'x'],
    ['SDLC_WORKER_MAX_EVENT_ATTEMPTS', '0'],
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
