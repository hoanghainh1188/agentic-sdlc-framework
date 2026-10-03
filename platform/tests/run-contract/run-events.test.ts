// D-08 C02 AC3 and the append-only text rule (CLAUDE.md, ADR-M22 section 2.5): run event payloads
// hold declared, coded fields only. Never free text, personal data or client data.
import { describe, expect, it } from 'vitest';

import { DbError } from '../../packages/core/src/db/errors.js';
import { checkRunEvent, RUN_EVENT_TYPES } from '../../packages/core/src/run-events/index.js';

const SHA = 'a'.repeat(64);
const refused = (type: string, payload: Record<string, unknown>) => () =>
  checkRunEvent(type, payload);

describe('run event payloads', () => {
  it('declares the C02, C04, C05, C06, C07, C08 and C11 event types', () => {
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
      'agent_started',
      'agent_stopped',
      'agent_finished',
      'agent_failed',
      'proposal_stored',
      'key_issued',
      'budget_warning',
      'diff_stored',
      'changes_checked',
      'branch_pushed',
      'publish_refused',
      'publish_failed',
      'ci_checked',
      'kill_requested',
      'token_revoked',
      'token_revoke_failed',
      'wrap_token_reused',
      'kill_evidence_failed',
    ]);
  });

  it('C08 PR 2: ci_checked holds codes, counts and a hash, never a check name', () => {
    const checked = {
      pr_number: 7,
      pr_state: 'open',
      head_sha: 'a'.repeat(40),
      state: 'passed',
      checks_sha256: 'b'.repeat(64),
      findings: 'known',
      critical: 0,
      high: 1,
      medium: 0,
      low: 3,
    };
    expect(checkRunEvent('ci_checked', checked)).toEqual(checked);
    expect(refused('ci_checked', { ...checked, state: 'lint, type check' })).toThrow(DbError);
    expect(refused('ci_checked', { ...checked, name: 'ci-ok' })).toThrow(DbError);
  });

  it('C08: branch_pushed holds commits and hashes; publish_refused and publish_failed a code', () => {
    const head = 'a'.repeat(40);
    const pushed = {
      head_sha: head,
      parent_sha: 'b'.repeat(40),
      diff_sha256: 'c'.repeat(64),
      paths_sha256: 'd'.repeat(64),
    };
    expect(checkRunEvent('branch_pushed', pushed)).toEqual(pushed);
    expect(refused('branch_pushed', { ...pushed, diff_sha256: 'x' })).toThrow(DbError);
    expect(refused('branch_pushed', { ...pushed, path: 'src/a.ts' })).toThrow(DbError);
    expect(checkRunEvent('publish_refused', { reason: 'branch_moved' })).toEqual({
      reason: 'branch_moved',
    });
    expect(refused('publish_failed', { reason: 'git said: no' })).toThrow(DbError);
  });

  it('C07: key_issued holds the cap as a decimal string and which budget set it', () => {
    expect(checkRunEvent('key_issued', { max_budget_usd: '0.5', limited_by: 'intent' })).toEqual({
      max_budget_usd: '0.5',
      limited_by: 'intent',
    });
    for (const amount of [0.5, '-1', '1e3', '0.1234567', '01.5', '']) {
      expect(refused('key_issued', { max_budget_usd: amount, limited_by: 'run' })).toThrow(DbError);
    }
    expect(refused('key_issued', { max_budget_usd: '1', limited_by: 'run', key: 'sk-x' })).toThrow(
      DbError,
    );
  });

  it('C07: budget_warning holds two decimals and a percent', () => {
    expect(
      checkRunEvent('budget_warning', { spend_usd: '0.41', max_budget_usd: '0.5', percent: 82 }),
    ).toEqual({ spend_usd: '0.41', max_budget_usd: '0.5', percent: 82 });
    expect(refused('budget_warning', { spend_usd: '0.41', max_budget_usd: '0.5' })).toThrow(
      DbError,
    );
  });

  it('C07: diff_stored and changes_checked hold hashes and counts only, never paths', () => {
    expect(checkRunEvent('diff_stored', { sha256: SHA, size_bytes: 10, changed_files: 2 })).toEqual(
      { sha256: SHA, size_bytes: 10, changed_files: 2 },
    );
    const checked = {
      changed_files: 4,
      out_of_scope: 1,
      instruction_files: 0,
      paths_sha256: SHA,
    };
    expect(checkRunEvent('changes_checked', checked)).toEqual(checked);
    expect(refused('changes_checked', { ...checked, out_of_scope_paths: 'a.ts' })).toThrow(DbError);
    expect(refused('changes_checked', { ...checked, paths_sha256: 'src/a.ts' })).toThrow(DbError);
  });

  it('C06 2b: proposal_stored holds a hash and counts only, never paths', () => {
    expect(
      checkRunEvent('proposal_stored', { sha256: SHA, size_bytes: 1024, changed_files: 3 }),
    ).toEqual({ sha256: SHA, size_bytes: 1024, changed_files: 3 });
    expect(
      refused('proposal_stored', { sha256: SHA, size_bytes: 1, changed_files: 1, path: 'a.ts' }),
    ).toThrow(DbError);
    expect(refused('proposal_stored', { sha256: 'x', size_bytes: 1, changed_files: 1 })).toThrow(
      DbError,
    );
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
