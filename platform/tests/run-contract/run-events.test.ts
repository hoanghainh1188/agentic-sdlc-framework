// D-08 C02 AC3 and the append-only text rule (CLAUDE.md, ADR-M22 section 2.5): run event payloads
// hold declared, coded fields only. Never free text, personal data or client data.
import { describe, expect, it } from 'vitest';

import { DbError } from '../../packages/core/src/db/errors.js';
import { checkRunEvent, RUN_EVENT_TYPES } from '../../packages/core/src/run-events/index.js';

const SHA = 'a'.repeat(64);
const refused = (type: string, payload: Record<string, unknown>) => () =>
  checkRunEvent(type, payload);

describe('run event payloads', () => {
  it('declares the C02 event types', () => {
    expect(Object.keys(RUN_EVENT_TYPES)).toEqual([
      'contract_issued',
      'contract_accepted',
      'contract_rejected',
    ]);
  });

  it('accepts the declared fields', () => {
    expect(checkRunEvent('contract_issued', { contract_sha256: SHA, key_version: 2 })).toEqual({
      contract_sha256: SHA,
      key_version: 2,
    });
    expect(checkRunEvent('contract_rejected', { reason: 'expired' })).toEqual({
      reason: 'expired',
    });
  });

  it.each([
    ['free text', { reason: 'customer Tanaka asked to stop' }],
    ['an e-mail address', { reason: 'tanaka@example.co.jp' }],
    ['a nested object', { reason: { text: 'x' } }],
    ['an array', { reason: ['expired'] }],
    ['null', { reason: null }],
    ['an undeclared field', { reason: 'expired', note: 'x' }],
    ['a missing field', {}],
    ['a long code', { reason: 'x'.repeat(65) }],
  ])('refuses %s', (_label, payload) => {
    expect(refused('contract_rejected', payload)).toThrow(DbError);
  });

  it('refuses unknown event types and badly formatted hashes and versions', () => {
    expect(refused('agent_said', { text: 'hello' })).toThrow(/unknown run event type/);
    expect(refused('contract_issued', { contract_sha256: 'A'.repeat(64), key_version: 1 })).toThrow(
      /contract_sha256/,
    );
    expect(refused('contract_issued', { contract_sha256: SHA, key_version: 0 })).toThrow(
      /key_version/,
    );
  });
});
