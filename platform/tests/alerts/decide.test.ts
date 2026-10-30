// `pnpm alerts` (O03, design/ADR-M101): when a doctor result is sent. A problem is sent when it
// appears or changes status, again after the reminder hours while it stays, and a "resolved" line
// when its check is ok again. A skipped check (a stopped stack) keeps what was known.
import { describe, expect, it } from 'vitest';

import { decide, keyOf } from '../../deploy/alerts/src/decide.js';
import type { CheckResult } from '../../deploy/doctor/src/types.js';

const NOW = new Date('2026-10-30T10:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const sealed: CheckResult = {
  id: 'openbao.state',
  status: 'failed',
  text: { key: 'doctor.openbao.sealed' },
  fix: { key: 'doctor.fix.unseal' },
};
const unsealed: CheckResult = {
  id: 'openbao.state',
  status: 'ok',
  text: { key: 'doctor.openbao.unsealed' },
};
const skippedBao: CheckResult = {
  id: 'openbao.state',
  status: 'skipped',
  text: { key: 'doctor.skipped.stopped' },
};
const diskLow = (status: 'warning' | 'failed'): CheckResult => ({
  id: 'host.disk',
  subject: '/mnt/backup',
  status,
  text: { key: 'doctor.disk.low', params: { gib: '3.0' } },
  fix: { key: 'doctor.fix.disk' },
});

describe('decide', () => {
  it('a new problem is sent and remembered by check and subject', () => {
    const { items, next } = decide({}, [sealed, diskLow('warning')], NOW, 24);
    expect(items.map((i) => [i.kind, keyOf(i.result)])).toEqual([
      ['problem', 'openbao.state|'],
      ['problem', 'host.disk|/mnt/backup'],
    ]);
    expect(next).toEqual({
      'openbao.state|': { status: 'failed', sentAt: NOW.toISOString() },
      'host.disk|/mnt/backup': { status: 'warning', sentAt: NOW.toISOString() },
    });
  });

  it('the same problem is not sent again before the reminder hours, then once more', () => {
    const before = { 'openbao.state|': { status: 'failed' as const, sentAt: hoursAgo(23) } };
    expect(decide(before, [sealed], NOW, 24)).toEqual({ items: [], next: before });
    const due = { 'openbao.state|': { status: 'failed' as const, sentAt: hoursAgo(24) } };
    const { items, next } = decide(due, [sealed], NOW, 24);
    expect(items.map((i) => i.kind)).toEqual(['reminder']);
    expect(next['openbao.state|']?.sentAt).toBe(NOW.toISOString());
  });

  it('a change of status (warning to failed) is sent at once', () => {
    const before = { 'host.disk|/mnt/backup': { status: 'warning' as const, sentAt: hoursAgo(1) } };
    expect(decide(before, [diskLow('failed')], NOW, 24).items.map((i) => i.kind)).toEqual([
      'problem',
    ]);
  });

  it('a check that is ok again is sent as resolved and forgotten', () => {
    const before = { 'openbao.state|': { status: 'failed' as const, sentAt: hoursAgo(2) } };
    const { items, next } = decide(before, [unsealed], NOW, 24);
    expect(items.map((i) => i.kind)).toEqual(['resolved']);
    expect(next).toEqual({});
  });

  it('ok checks that were never a problem send nothing', () => {
    expect(decide({}, [unsealed], NOW, 24)).toEqual({ items: [], next: {} });
  });

  it('a skipped check keeps what was known: no resolved line, no new problem', () => {
    const before = { 'openbao.state|': { status: 'failed' as const, sentAt: hoursAgo(2) } };
    expect(decide(before, [skippedBao], NOW, 24)).toEqual({ items: [], next: before });
  });

  it('a problem whose check or subject is gone is forgotten without a message', () => {
    const before = { 'host.disk|/old': { status: 'warning' as const, sentAt: hoursAgo(2) } };
    expect(decide(before, [unsealed], NOW, 24)).toEqual({ items: [], next: {} });
  });
});
