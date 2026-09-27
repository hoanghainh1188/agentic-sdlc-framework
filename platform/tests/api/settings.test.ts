// B03 api settings (ADR-M26 section 2.6): defaults, OpenBao by default, dev mode never in production.
import { describe, expect, it } from 'vitest';

import { loadSettings, SettingsError } from '../../apps/api/src/settings.js';

describe('api settings', () => {
  it('defaults: OpenBao for the database password, 127.0.0.1:8080', () => {
    expect(loadSettings({})).toEqual({
      host: '127.0.0.1',
      port: 8080,
      database: {
        kind: 'openbao',
        host: 'postgres',
        port: 5432,
        name: 'platform',
        secretPath: 'api/database',
      },
      rateLimitPerMinute: 120,
      authFailuresPerMinute: 10,
    });
  });

  it('dev mode takes a URL, and is refused in production', () => {
    expect(
      loadSettings({ SDLC_API_DEV_MODE: '1', SDLC_API_DEV_DB_URL: 'postgres://x/platform' })
        .database,
    ).toEqual({ kind: 'dev_url', url: 'postgres://x/platform' });
    expect(() => loadSettings({ SDLC_API_DEV_MODE: '1' })).toThrow(SettingsError);
    expect(() =>
      loadSettings({
        SDLC_API_DEV_MODE: '1',
        SDLC_API_DEV_DB_URL: 'postgres://x/platform',
        NODE_ENV: 'production',
      }),
    ).toThrowError(expect.objectContaining({ key: 'api.settings.dev_mode_in_production' }));
  });

  it.each([
    ['SDLC_API_PORT', '0'],
    ['SDLC_API_PORT', 'abc'],
    ['SDLC_API_DB_SECRET_PATH', 'worker/database'],
    ['SDLC_API_DB_NAME', 'Platform;drop'],
    ['SDLC_API_DEV_MODE', 'yes'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => loadSettings({ [name]: value })).toThrowError(
      expect.objectContaining({ key: 'api.settings.invalid', setting: name }),
    );
  });
});
