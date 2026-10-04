// D-08 E05 (design/ADR-M51; D-05 §10.1; D-02 FR-44): the retention rules with a fake clock. One
// clock per intent from the later of its end and the row's creation; open and held intents are
// never purged; nothing younger than 180 days is purged for retention, whatever the config says;
// an archived project's evidence goes after the archive grace period; the guard; the lock target.
import { loadProjectConfig } from '@sdlc/config';
import {
  addDays,
  archivePurgeDue,
  guardTrips,
  lockTarget,
  MIN_EVIDENCE_AGE_DAYS,
  purgeDecision,
  retentionCutoff,
  retentionEnds,
  type RowFacts,
} from '../../packages/core/src/retention/rules.js';
import { describe, expect, it } from 'vitest';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (days: number) => addDays(T0, days);

const facts = (over: Partial<RowFacts> = {}): RowFacts => ({
  now: at(181),
  intentStatus: 'done',
  intentUpdatedAt: T0,
  createdAt: T0,
  held: false,
  retentionDays: 180,
  archivePurgeDue: false,
  ...over,
});

describe('E05 AC1: retention of a finished intent', () => {
  it('keeps the files at day 179 and purges them at day 181 (default 180 days)', () => {
    expect(purgeDecision(facts({ now: at(179) }))).toEqual({ purge: false, reason: 'retention' });
    expect(purgeDecision(facts({ now: at(181) }))).toEqual({ purge: true, cause: 'retention' });
    // Exactly at the end: due (the selection uses `<=`).
    expect(purgeDecision(facts({ now: at(180) }))).toEqual({ purge: true, cause: 'retention' });
  });

  it('counts from the later of the intent end and the row creation', () => {
    // A pack built 30 days after the intent ended.
    const late = facts({ createdAt: at(30), now: at(200) });
    expect(purgeDecision(late)).toEqual({ purge: false, reason: 'retention' });
    expect(purgeDecision({ ...late, now: at(211) })).toEqual({ purge: true, cause: 'retention' });
    // An item older than the intent's end: the end counts.
    const ended = facts({ createdAt: T0, intentUpdatedAt: at(100), now: at(270) });
    expect(purgeDecision(ended)).toEqual({ purge: false, reason: 'retention' });
    expect(retentionEnds({ ...ended, retentionDays: 180 })).toEqual(at(280));
  });

  it('follows a longer project retention', () => {
    const long = facts({ retentionDays: 365, now: at(364) });
    expect(purgeDecision(long)).toEqual({ purge: false, reason: 'retention' });
    expect(purgeDecision({ ...long, now: at(366) })).toEqual({ purge: true, cause: 'retention' });
  });

  it('never purges an open intent, whatever its age', () => {
    for (const status of ['draft', 'in_gate', 'running', 'paused']) {
      expect(purgeDecision(facts({ intentStatus: status, now: at(5000) }))).toEqual({
        purge: false,
        reason: 'open',
      });
    }
    for (const status of ['done', 'rejected', 'cancelled', 'blocked']) {
      expect(purgeDecision(facts({ intentStatus: status })).purge).toBe(true);
    }
  });

  it('never purges a held intent, also an archived one', () => {
    expect(purgeDecision(facts({ held: true, now: at(5000) }))).toEqual({
      purge: false,
      reason: 'held',
    });
    expect(purgeDecision(facts({ held: true, archivePurgeDue: true }))).toEqual({
      purge: false,
      reason: 'held',
    });
  });

  it('keeps the 180-day code minimum even when the configuration says less (bug or tampering)', () => {
    expect(MIN_EVIDENCE_AGE_DAYS).toBe(180);
    expect(purgeDecision(facts({ retentionDays: 1, now: at(10) }))).toEqual({
      purge: false,
      reason: 'min_age',
    });
    expect(purgeDecision(facts({ retentionDays: 0, now: at(179) }))).toEqual({
      purge: false,
      reason: 'min_age',
    });
    expect(purgeDecision(facts({ retentionDays: 1, now: at(181) }))).toEqual({
      purge: true,
      cause: 'retention',
    });
    // The database cut-off never selects younger rows either.
    expect(retentionCutoff(at(181), 1)).toEqual(at(1));
    expect(retentionCutoff(at(400), 365)).toEqual(at(35));
  });

  it('purges nothing for retention without a usable configuration (fail closed)', () => {
    expect(purgeDecision(facts({ retentionDays: null, now: at(5000) }))).toEqual({
      purge: false,
      reason: 'retention',
    });
  });
});

describe('E05 AC3: archived projects and their grace period', () => {
  it('purges after the grace: day 6 kept, day 8 purged (default 7 days)', () => {
    const archived = at(10);
    expect(archivePurgeDue(at(16), archived, 7)).toBe(false);
    expect(archivePurgeDue(at(18), archived, 7)).toBe(true);
    // An archive time that cannot be read: never.
    expect(archivePurgeDue(at(5000), null, 7)).toBe(false);
  });

  it('purges an archived project before the 180 days, but never an open or held intent', () => {
    const young = facts({ now: at(20), archivePurgeDue: true });
    expect(purgeDecision(young)).toEqual({ purge: true, cause: 'archive' });
    expect(purgeDecision({ ...young, intentStatus: 'running' })).toEqual({
      purge: false,
      reason: 'open',
    });
  });
});

describe('E05: the purge guard', () => {
  it('stops a pass that would purge more than the share of a tenant, or the floor', () => {
    const guard = { percent: 20, floor: 20 };
    expect(guardTrips(20, 50, guard)).toBe(false);
    expect(guardTrips(21, 50, guard)).toBe(true);
    expect(guardTrips(200, 1000, guard)).toBe(false);
    expect(guardTrips(201, 1000, guard)).toBe(true);
    expect(guardTrips(1, 0, { percent: 20, floor: 0 })).toBe(true);
  });
});

describe('E05: the lock of projects that keep evidence longer than 180 days', () => {
  const lockFacts = {
    now: at(170),
    intentStatus: 'running',
    intentUpdatedAt: T0,
    createdAt: T0,
    lockExtendedUntil: null,
    retentionDays: 365,
  };

  it('moves nothing for a 180-day project', () => {
    expect(lockTarget({ ...lockFacts, retentionDays: 180 })).toBeNull();
  });

  it('moves nothing while the lock ends later than the margin', () => {
    expect(lockTarget({ ...lockFacts, now: at(100) })).toBeNull();
  });

  it('moves an open intent to retention days from now, a finished one to its retention end', () => {
    expect(lockTarget(lockFacts)).toEqual(at(170 + 365));
    expect(lockTarget({ ...lockFacts, intentStatus: 'done', intentUpdatedAt: at(10) })).toEqual(
      at(375),
    );
  });

  it('never moves a lock backwards, and stops once the retention is over', () => {
    expect(lockTarget({ ...lockFacts, lockExtendedUntil: at(900) })).toBeNull();
    expect(lockTarget({ ...lockFacts, intentStatus: 'done', now: at(400) })).toBeNull();
  });
});

describe('E05: mandatory rule M31 bounds', () => {
  it('accepts 180 and 3650 days', () => {
    for (const days of [180, 3650]) {
      const result = loadProjectConfig(`retention:\n  evidence_retention_days: ${days}\n`);
      expect(result.ok, String(days)).toBe(true);
    }
  });
});
