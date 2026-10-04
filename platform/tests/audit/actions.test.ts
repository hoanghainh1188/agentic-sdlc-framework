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

// Codes, the version and the record hash only (B12, ADR-M32 §2.2).
const AI_RECORD_PAYLOAD = {
  version: 1,
  record_sha256: HASH,
  ai_allowed: 'yes',
  prod_logs_allowed: 'no',
  disclosure_format: 'standard_note',
  consent: 'unknown',
  updated_by: SOME_ID,
};

describe('checkAuditEvent', () => {
  it('accepts the declared fields and returns exactly them', () => {
    expect(checkAuditEvent('config.changed', SOME_ID, { config_hash: HASH, version: 3 })).toEqual({
      entityType: 'project',
      payload: { version: 3, config_hash: HASH },
    });
    expect(checkAuditEvent('ai_record.changed', SOME_ID, AI_RECORD_PAYLOAD)).toEqual({
      entityType: 'project',
      payload: AI_RECORD_PAYLOAD,
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
      { record_ref: 'https://docs.example.test/ai-record' },
      { note: 'free text' },
    ]) {
      expect(
        rejection(() =>
          checkAuditEvent('ai_record.changed', SOME_ID, { ...AI_RECORD_PAYLOAD, ...extra }),
        ),
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
      count: Number.MAX_SAFE_INTEGER,
      decimal: '999999999999.999999',
      code: 'X'.repeat(64),
    };
    for (const [action, spec] of Object.entries(AUDIT_ACTIONS)) {
      const payload = Object.fromEntries(
        // Optional fields (`kind?`) count at their maximum size too.
        Object.entries(spec.fields).map(([field, declared]) => [
          field,
          maxValue[declared.replace('?', '') as keyof typeof maxValue],
        ]),
      );
      expect(Buffer.byteLength(JSON.stringify(payload)), action).toBeLessThanOrEqual(
        MAX_AUDIT_PAYLOAD_BYTES,
      );
    }
  });
});

describe('optional audit fields (ADR-M20)', () => {
  const decided = {
    decision_id: SOME_ID,
    gate: 'G3',
    decision: 'approve',
    oversight_mode: 'HITL',
    input_sha256: HASH,
    config_hash: HASH,
  };

  it('may be left out, and are returned only when present', () => {
    expect(checkAuditEvent('gate.decided', SOME_ID, decided).payload).toEqual(decided);
    expect(
      checkAuditEvent('gate.decided', SOME_ID, { ...decided, approver_role: 'person_b' }).payload,
    ).toEqual({ ...decided, approver_role: 'person_b' });
    expect(
      checkAuditEvent('intent.state_changed', SOME_ID, { status: 'draft', current_gate: undefined })
        .payload,
    ).toEqual({ status: 'draft' });
  });

  it('follow the same format rules when present, and are never null', () => {
    for (const bad of [
      { approver_role: null },
      { reason_code: 'the spec is unclear' },
      { voids_decision_id: 'not-a-uuid' },
    ]) {
      expect(
        rejection(() => checkAuditEvent('gate.decided', SOME_ID, { ...decided, ...bad })),
        JSON.stringify(bad),
      ).toBe('invalid_value');
    }
  });

  it('registry actions never declare a field for titles, paths, summaries or reasons', () => {
    const fields = [
      'intent.created',
      'intent.state_changed',
      'spec.linked',
      'plan.submitted',
      'gate.decided',
    ].flatMap((action) => Object.keys(AUDIT_ACTIONS[action as keyof typeof AUDIT_ACTIONS].fields));
    for (const forbidden of [
      'title',
      'description',
      'path',
      'summary',
      'reason',
      'reason_ref',
      'planned_files',
    ]) {
      expect(fields).not.toContain(forbidden);
    }
  });
});

describe('E03: the `count` kind and the G8 actions (ADR-M49)', () => {
  const closed = {
    pack_id: SOME_ID,
    pack_version: 2,
    release_sha256: HASH,
    lead_time_seconds: 0,
    runs: 1,
    g7_change_requests: 0,
    cost_usd: '0.012000',
    input_tokens: '1000',
    output_tokens: '200',
  };

  it('`intent.closed` takes counts of 0 or more; never a negative, a fraction or a string', () => {
    expect(checkAuditEvent('intent.closed', SOME_ID, closed).payload).toEqual(closed);
    for (const bad of [-1, 1.5, '3']) {
      expect(() =>
        checkAuditEvent('intent.closed', SOME_ID, { ...closed, lead_time_seconds: bad }),
      ).toThrow();
    }
  });

  it('`evidence.pack_sealed` and `gate.g8_check_failed` hold IDs, versions, hashes and codes', () => {
    expect(() =>
      checkAuditEvent('evidence.pack_sealed', SOME_ID, {
        intent_id: SOME_ID,
        version: 1,
        content_sha256: HASH,
        release_sha256: HASH,
      }),
    ).not.toThrow();
    expect(() =>
      checkAuditEvent('gate.g8_check_failed', SOME_ID, {
        check: 'evidence_hash_mismatch',
        escalation_id: SOME_ID,
      }),
    ).not.toThrow();
  });
});
