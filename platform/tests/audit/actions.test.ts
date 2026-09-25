// ADR-M09 section 2.8: audit payloads hold only declared fields (IDs, codes, hashes, versions),
// never personal or client data, and stay small.
import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  checkAuditEvent,
  MAX_AUDIT_PAYLOAD_BYTES,
} from '../../packages/core/src/audit/actions.js';
import { DbError } from '../../packages/core/src/db/errors.js';
import { SOME_ID } from '../db/dummy.js';

const HASH = 'ab'.repeat(32);

function rejection(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof DbError) return error.code;
    throw error;
  }
}

describe('checkAuditEvent', () => {
  it('accepts the declared fields and returns exactly them', () => {
    expect(checkAuditEvent('config.changed', SOME_ID, { config_hash: HASH, version: 3 })).toEqual({
      entityType: 'project',
      payload: { version: 3, config_hash: HASH },
    });
    expect(checkAuditEvent('ai_record.changed', SOME_ID, { version: 1 })).toEqual({
      entityType: 'project',
      payload: { version: 1 },
    });
  });

  it('rejects an unknown action', () => {
    expect(rejection(() => checkAuditEvent('user.renamed', SOME_ID, {}))).toBe('invalid_value');
  });

  it('rejects undeclared fields, so personal or client data cannot slip in', () => {
    for (const extra of [
      { email: 'someone@example.com' },
      { config_yaml: 'gates: {}' },
      { confirmed_by: 'Client contact' },
      { note: 'free text' },
    ]) {
      expect(
        rejection(() => checkAuditEvent('ai_record.changed', SOME_ID, { version: 1, ...extra })),
        JSON.stringify(extra),
      ).toBe('invalid_value');
    }
  });

  it('rejects missing and badly formatted fields', () => {
    const cases: Record<string, unknown>[] = [
      { version: 1 },
      { version: 0, config_hash: HASH },
      { version: 1.5, config_hash: HASH },
      { version: '1', config_hash: HASH },
      { version: 1, config_hash: HASH.toUpperCase() },
      { version: 1, config_hash: 'not a hash' },
    ];
    for (const payload of cases) {
      expect(
        rejection(() => checkAuditEvent('config.changed', SOME_ID, payload)),
        JSON.stringify(payload),
      ).toBe('invalid_value');
    }
  });

  it('requires a UUID entity ID for actions about an entity', () => {
    expect(
      rejection(() => checkAuditEvent('config.changed', null, { version: 1, config_hash: HASH })),
    ).toBe('invalid_value');
    expect(
      rejection(() =>
        checkAuditEvent('config.changed', 'my-project', { version: 1, config_hash: HASH }),
      ),
    ).toBe('invalid_value');
  });

  it('every declared action fits the payload size limit even at maximum field sizes', () => {
    const maxValue = {
      uuid: SOME_ID,
      sha256: HASH,
      version: Number.MAX_SAFE_INTEGER,
      code: 'X'.repeat(64),
    };
    for (const [action, spec] of Object.entries(AUDIT_ACTIONS)) {
      const payload = Object.fromEntries(
        Object.entries(spec.fields).map(([field, kind]) => [field, maxValue[kind]]),
      );
      expect(Buffer.byteLength(JSON.stringify(payload)), action).toBeLessThanOrEqual(
        MAX_AUDIT_PAYLOAD_BYTES,
      );
    }
  });
});
