// D-08 E08 (design/ADR-M53): how the worker opens its Langfuse purge. `SDLC_WORKER_LANGFUSE_URL=off`
// → `not_deployed`; configured but the OpenBao entry is missing or incomplete → `unavailable`
// (archived projects wait); all five fields → `on`, the raw store limited to `events/otel/`.
// Never a secret value in a log line.
import type { RedactedSecret, SecretEntry, SecretReader } from '@sdlc/contracts';
import { SecretsError } from '@sdlc/secrets';
import { describe, expect, it } from 'vitest';

import { openLangfusePurge } from '../../apps/worker/src/langfuse-store.js';
import type { WorkerLangfuseSettings } from '../../apps/worker/src/settings.js';

const secret = (value: string): RedactedSecret =>
  ({ reveal: () => value, toString: () => '[redacted]' }) as RedactedSecret;

const settings: WorkerLangfuseSettings = {
  url: 'http://langfuse-web:3000',
  secretPath: 'worker/langfuse',
  projectId: 'sdlc-platform',
  clickhouseUrl: 'http://clickhouse:8123',
  batch: 50,
  rawUrl: 'http://seaweedfs:8333',
  rawBucket: 'langfuse',
  rawMaxAgeHours: 24,
  rawBatch: 2000,
};
const FULL = {
  langfuse_public_key: 'pk-lf-worker',
  langfuse_secret_key: 'sk-lf-worker-secret',
  clickhouse_password: 'ch-password-value',
  access_key: 'sdlcwrklfabc',
  secret_key: 's3-secret-value',
};

function reader(fields: Record<string, string> | 'missing'): SecretReader {
  return {
    read: (path) => {
      expect(path).toBe('worker/langfuse');
      if (fields === 'missing') return Promise.reject(new SecretsError('secrets.not_found'));
      const data = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, secret(v)]));
      return Promise.resolve({ data, version: 1 } as unknown as SecretEntry);
    },
  };
}

function logger() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      log: (level: string, event: string, fields = {}) =>
        lines.push(JSON.stringify({ level, event, ...fields })),
    },
  };
}

const state = () => ({ maskOwed: false, maskedOn: null });
const GUARD = { percent: 20, floor: 20 };

describe('E08: openLangfusePurge', () => {
  it('off → not_deployed, with a warning', async () => {
    const l = logger();
    const opened = await openLangfusePurge(null, reader(FULL), l.log, state(), GUARD);
    expect(opened.deps).toEqual({ status: 'not_deployed' });
    expect(l.lines.join()).toContain('worker.langfuse_off');
  });

  it('a missing or incomplete entry → unavailable (archived projects wait)', async () => {
    const withoutPassword: Record<string, string> = { ...FULL };
    delete withoutPassword.clickhouse_password;
    const cases: (Record<string, string> | 'missing')[] = [
      'missing',
      withoutPassword,
      { ...FULL, clickhouse_password: '' },
    ];
    for (const fields of cases) {
      const l = logger();
      const opened = await openLangfusePurge(settings, reader(fields), l.log, state(), GUARD);
      expect(opened.deps).toEqual({ status: 'unavailable' });
      expect(l.lines.join()).toContain('worker.langfuse_missing');
    }
  });

  it('every field → on, the raw store limited to events/otel/, no secret in a log line', async () => {
    const l = logger();
    const s = state();
    const opened = await openLangfusePurge(settings, reader(FULL), l.log, s, GUARD);
    expect(opened.deps.status).toBe('on');
    if (opened.deps.status !== 'on') return;
    expect(opened.deps.rawPrefix).toBe('events/otel/');
    expect(opened.deps.settings).toEqual({
      batch: 50,
      rawMaxAgeHours: 24,
      rawBatch: 2000,
      projectId: 'sdlc-platform',
      guardPercent: 20,
      guardFloor: 20,
    });
    expect(opened.deps.state).toBe(s);
    // The raw store refuses any other prefix or bucket.
    await expect(opened.deps.rawStore.listKeys('media/', null, 10)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      opened.deps.rawStore.deleteAllVersions('s3://evidence/packs/x', { bypassLock: false }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    opened.destroy();
    for (const value of Object.values(FULL)) expect(l.lines.join()).not.toContain(value);
  });

  it('other OpenBao errors are not hidden', async () => {
    const failing: SecretReader = {
      read: () => Promise.reject(new SecretsError('secrets.openbao.unreachable')),
    };
    await expect(
      openLangfusePurge(settings, failing, logger().log, state(), GUARD),
    ).rejects.toBeInstanceOf(SecretsError);
  });
});
