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
      temporal: { address: 'temporal:7233', namespace: 'default' },
      githubApiUrl: 'https://api.github.com',
      dashboardDir: null,
      evidence: {
        url: 'http://seaweedfs:8333',
        bucket: 'evidence',
        secretPath: 'api/evidence',
        maxItemBytes: 256 * 1024 * 1024,
      },
    });
  });

  it('E02: the evidence store is an origin, a bucket and a path under api/; off turns it off', () => {
    expect(loadSettings({ SDLC_API_EVIDENCE_URL: 'off' }).evidence).toBeNull();
    expect(
      loadSettings({
        SDLC_API_EVIDENCE_URL: 'https://s3.internal:8443',
        SDLC_API_EVIDENCE_BUCKET: 'packs-1',
        SDLC_API_EVIDENCE_SECRET_PATH: 'api/evidence2',
        SDLC_API_EVIDENCE_MAX_ITEM_MB: '8',
      }).evidence,
    ).toEqual({
      url: 'https://s3.internal:8443',
      bucket: 'packs-1',
      secretPath: 'api/evidence2',
      maxItemBytes: 8 * 1024 * 1024,
    });
    for (const [name, value] of [
      ['SDLC_API_EVIDENCE_URL', 'http://user:pass@seaweedfs:8333'],
      ['SDLC_API_EVIDENCE_URL', 'http://seaweedfs:8333/evidence'],
      ['SDLC_API_EVIDENCE_URL', 'file:///tmp'],
      ['SDLC_API_EVIDENCE_BUCKET', 'Evidence_1'],
      // The AppRole "api" reads kv/data/api/* only: another path is a mistake.
      ['SDLC_API_EVIDENCE_SECRET_PATH', 'runner/evidence'],
      ['SDLC_API_EVIDENCE_MAX_ITEM_MB', '0'],
    ] as const) {
      expect(() => loadSettings({ [name]: value }), `${name}=${value}`).toThrowError(
        expect.objectContaining({ key: 'api.settings.invalid', setting: name }),
      );
    }
  });

  it('B08: the GitHub API URL of the spec endpoints is https only', () => {
    expect(
      loadSettings({ SDLC_API_GITHUB_API_URL: 'https://ghe.example.test/api/v3' }).githubApiUrl,
    ).toBe('https://ghe.example.test/api/v3');
  });

  it('B07: the intent workflow signals can be turned off in development mode only', () => {
    const dev = { SDLC_API_DEV_MODE: '1', SDLC_API_DEV_DB_URL: 'postgres://x/platform' };
    expect(loadSettings({ ...dev, SDLC_API_TEMPORAL_ADDRESS: 'off' }).temporal).toBeNull();
    expect(() => loadSettings({ SDLC_API_TEMPORAL_ADDRESS: 'off' })).toThrowError(
      expect.objectContaining({ key: 'api.settings.temporal_off_in_production' }),
    );
    expect(
      loadSettings({
        SDLC_API_TEMPORAL_ADDRESS: 'tmp.internal:7300',
        SDLC_API_TEMPORAL_NAMESPACE: 'sdlc',
      }).temporal,
    ).toEqual({ address: 'tmp.internal:7300', namespace: 'sdlc' });
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
    ['SDLC_API_TEMPORAL_ADDRESS', 'http://temporal:7233'],
    ['SDLC_API_TEMPORAL_NAMESPACE', 'a b'],
    ['SDLC_API_GITHUB_API_URL', 'http://api.github.com'],
  ])('refuses %s=%s', (name, value) => {
    expect(() => loadSettings({ [name]: value })).toThrowError(
      expect.objectContaining({ key: 'api.settings.invalid', setting: name }),
    );
  });

  it('U01: the dashboard folder is off by default, else an absolute path', () => {
    expect(loadSettings({ SDLC_API_DASHBOARD_DIR: '/app/dashboard' }).dashboardDir).toBe(
      '/app/dashboard',
    );
    expect(() => loadSettings({ SDLC_API_DASHBOARD_DIR: 'dist' })).toThrow(SettingsError);
  });
});
