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
      runs: null,
      costSync: {
        intervalMs: 300_000,
        lookbackMs: 7_200_000,
        catchUpMs: 86_400_000,
        settleMs: 1_800_000,
      },
      evidence: {
        url: 'http://seaweedfs:8333',
        bucket: 'evidence',
        secretPath: 'worker/evidence',
        maxItemBytes: 256 * 1024 * 1024,
      },
      retention: {
        url: 'http://seaweedfs:8333',
        bucket: 'evidence',
        secretPath: 'worker/purge',
        mode: 'report',
        intervalMs: 3_600_000,
        batch: 200,
        guardPercent: 20,
        guardFloor: 20,
        archiveGraceDays: 7,
        orphanGraceHours: 24,
      },
    });
  });

  it('C12: the spend sync window holds two passes at least and the catch-up covers the look-back', () => {
    expect(
      loadSettings({
        SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS: '600',
        SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES: '20',
        SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES: '20',
        SDLC_WORKER_COST_SYNC_SETTLE_MINUTES: '5',
      }).costSync,
    ).toEqual({
      intervalMs: 600_000,
      lookbackMs: 1_200_000,
      catchUpMs: 1_200_000,
      settleMs: 300_000,
    });
    expect(() =>
      loadSettings({
        SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS: '600',
        SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES: '19',
      }),
    ).toThrow(expect.objectContaining({ setting: 'SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES' }));
    expect(() =>
      loadSettings({
        SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES: '120',
        SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES: '119',
      }),
    ).toThrow(expect.objectContaining({ setting: 'SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES' }));
  });

  it('E03: the evidence store for G8 (an origin, the worker KV path, a size cap; off)', () => {
    expect(loadSettings({ SDLC_WORKER_EVIDENCE_URL: 'off' }).evidence).toBeNull();
    expect(
      loadSettings({
        SDLC_WORKER_EVIDENCE_URL: 'http://seaweedfs:8333/',
        SDLC_WORKER_EVIDENCE_MAX_ITEM_MB: '8',
      }).evidence,
    ).toMatchObject({ url: 'http://seaweedfs:8333', maxItemBytes: 8 * 1024 * 1024 });
    for (const env of [
      { SDLC_WORKER_EVIDENCE_URL: 'http://seaweedfs:8333/evidence' },
      { SDLC_WORKER_EVIDENCE_URL: 'http://user:pw@seaweedfs:8333' },
      { SDLC_WORKER_EVIDENCE_URL: 'ftp://seaweedfs' },
      // The worker AppRole reads kv/data/worker/* only.
      { SDLC_WORKER_EVIDENCE_SECRET_PATH: 'api/evidence' },
      { SDLC_WORKER_EVIDENCE_MAX_ITEM_MB: '0' },
      { SDLC_WORKER_EVIDENCE_BUCKET: 'Evidence' },
    ]) {
      expect(() => loadSettings(env), JSON.stringify(env)).toThrow(
        expect.objectContaining({ key: 'worker.settings.invalid' }),
      );
    }
  });

  it('C06 session 2: agent runs need both files of the cost-controller AppRole', () => {
    const files = {
      SDLC_WORKER_COST_ROLE_ID_FILE: '/run/sdlc/cost-approle/role_id',
      SDLC_WORKER_COST_SECRET_ID_FILE: '/run/sdlc/cost-approle/secret_id',
    };
    expect(loadSettings(files).runs).toEqual({
      costRoleIdFile: '/run/sdlc/cost-approle/role_id',
      costSecretIdFile: '/run/sdlc/cost-approle/secret_id',
      costMasterKeyPath: 'cost-controller/litellm-master-key',
      litellmUrl: 'http://litellm:4000',
      egressAllowlist: ['litellm:4000', 'npm-proxy:4873'],
    });
    expect(() =>
      loadSettings({ SDLC_WORKER_COST_ROLE_ID_FILE: files.SDLC_WORKER_COST_ROLE_ID_FILE }),
    ).toThrow(expect.objectContaining({ key: 'worker.settings.cost_role_incomplete' }));
    // The AppRole reads its own paths only; the egress list names services with ports.
    for (const bad of [
      { SDLC_WORKER_COST_MASTER_KEY_PATH: 'worker/litellm-master-key' },
      { SDLC_WORKER_RUN_EGRESS: 'litellm' },
      { SDLC_WORKER_RUN_EGRESS: 'api.github.com:443,x' },
      { SDLC_WORKER_LITELLM_URL: 'http://user:pw@litellm:4000' },
    ]) {
      expect(() => loadSettings({ ...files, ...bad })).toThrow(
        expect.objectContaining({ key: 'worker.settings.invalid' }),
      );
    }
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
    ['SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS', '29'],
    ['SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS', '3601'],
    ['SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES', '9'],
    ['SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES', '1441'],
    ['SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES', '10081'],
    ['SDLC_WORKER_COST_SYNC_SETTLE_MINUTES', '4'],
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
