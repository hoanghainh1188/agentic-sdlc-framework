// D-08 C02 AC3 and the append-only text rule (CLAUDE.md, ADR-M22 section 2.5): run event payloads
// hold declared, coded fields only. Never free text, personal data or client data.
import { describe, expect, it } from 'vitest';

import { DbError } from '../../packages/core/src/db/errors.js';
import { checkRunEvent, RUN_EVENT_TYPES } from '../../packages/core/src/run-events/index.js';

const SHA = 'a'.repeat(64);
const refused = (type: string, payload: Record<string, unknown>) => () =>
  checkRunEvent(type, payload);

describe('run event payloads', () => {
  it('declares the C02 and C04 event types', () => {
    expect(Object.keys(RUN_EVENT_TYPES)).toEqual([
      'contract_issued',
      'contract_accepted',
      'contract_rejected',
      'workspace_prepared',
      'sandbox_created',
      'sandbox_ready',
      'provisioning_failed',
      'sandbox_removed',
      'run_abandoned',
    ]);
  });

  it('accepts the C04 sandbox events with coded fields only (ADR-M25)', () => {
    expect(
      checkRunEvent('workspace_prepared', { base_sha: 'f'.repeat(40), duration_ms: 812 }),
    ).toEqual({ base_sha: 'f'.repeat(40), duration_ms: 812 });
    expect(checkRunEvent('sandbox_created', { image_sha256: SHA })).toEqual({ image_sha256: SHA });
    expect(checkRunEvent('sandbox_ready', { duration_ms: 5000 })).toEqual({ duration_ms: 5000 });
    expect(checkRunEvent('provisioning_failed', { reason: 'egress_not_enforceable' })).toEqual({
      reason: 'egress_not_enforceable',
    });
    expect(checkRunEvent('sandbox_removed', { reason: 'orphan', duration_ms: 0 })).toEqual({
      reason: 'orphan',
      duration_ms: 0,
    });
    expect(checkRunEvent('run_abandoned', { previous_status: 'running' })).toEqual({
      previous_status: 'running',
    });
  });

  it.each([
    ['workspace_prepared', { base_sha: 'agent/INT-2026-0001', duration_ms: 1 }],
    ['workspace_prepared', { base_sha: 'f'.repeat(40), duration_ms: -1 }],
    ['sandbox_created', { image_sha256: 'sha256:' + SHA }],
    ['sandbox_created', { image_sha256: SHA, image: 'registry/name' }],
    ['provisioning_failed', { reason: 'git clone failed: auth' }],
    ['sandbox_removed', { reason: 'finished' }],
    ['run_abandoned', {}],
    ['run_abandoned', { previous_status: 'the runner crashed' }],
    ['run_abandoned', { previous_status: 'running', host: 'server-1' }],
  ])('refuses a bad %s payload', (type, payload) => {
    expect(refused(type, payload)).toThrow(DbError);
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
