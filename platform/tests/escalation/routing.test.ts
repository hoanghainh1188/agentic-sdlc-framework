// D-08 B11 AC1, AC2 and AC4 (pure parts): routing from the configuration and the role bindings,
// who is told what, the decision packet, the freeze rule and escalation codes (handbook Ch.6
// §6.4–§6.5, QUESTIONS #74–#76, design/ADR-M28). Database behaviour:
// tests/integration/db/escalations.test.ts.
import type { ProjectRole, ValidatedProjectConfig } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  formatEscalationCode,
  parseEscalationCode,
} from '../../packages/core/src/escalation/code.js';
import { EscalationError } from '../../packages/core/src/escalation/errors.js';
import { isFreezing } from '../../packages/core/src/escalation/freeze.js';
import { clockNotices, raisedNotices } from '../../packages/core/src/escalation/notices.js';
import { checkPacket } from '../../packages/core/src/escalation/packet.js';
import {
  firstStep,
  holdersFrom,
  isUnrouted,
  pickHolder,
} from '../../packages/core/src/escalation/routing.js';
import type { RoleBinding } from '../../packages/core/src/db/schema.js';
import { loadValid } from '../config/helpers';

const SETTINGS = (loadValid().config as ValidatedProjectConfig).escalation;
const HASH = 'a'.repeat(64);

let seq = 0;
function binding(userId: string, role: ProjectRole, minute: number, revoked = false): RoleBinding {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    tenant_id: 't',
    user_id: userId,
    project_id: 'p',
    role,
    revoked_at: revoked ? new Date('2026-09-01T00:00:00Z') : null,
    created_at: new Date(Date.UTC(2026, 8, 1, 0, minute)),
  };
}

const ALL_ACTIVE = new Set(['alice', 'bob', 'carol', 'dave', 'gina', 'gus']);

describe('routing (QUESTIONS #74)', () => {
  const bindings = [
    binding('bob', 'person_b', 2),
    binding('alice', 'person_a', 1),
    binding('carol', 'second_approver', 3),
    binding('gina', 'governance', 4),
    binding('gus', 'governance', 5),
  ];

  it('owner and backup come from the route roles of the configuration', () => {
    expect(holdersFrom(bindings, ALL_ACTIVE, SETTINGS.routing.intent, [])).toEqual({
      ownerId: 'alice',
      backupOwnerId: 'bob',
      hasGovernance: true,
    });
    expect(holdersFrom(bindings, ALL_ACTIVE, SETTINGS.routing.technical, [])).toEqual({
      ownerId: 'bob',
      backupOwnerId: 'carol',
      hasGovernance: true,
    });
    expect(holdersFrom(bindings, ALL_ACTIVE, SETTINGS.routing.policy, [])).toEqual({
      ownerId: 'gina',
      backupOwnerId: null,
      hasGovernance: true,
    });
  });

  it('never picks a producer (FR-18); picks the next holder instead', () => {
    const more = [...bindings, binding('dave', 'person_a', 9)];
    expect(holdersFrom(more, ALL_ACTIVE, SETTINGS.routing.intent, ['alice']).ownerId).toBe('dave');
    expect(
      holdersFrom(bindings, ALL_ACTIVE, SETTINGS.routing.intent, ['alice']).ownerId,
    ).toBeNull();
    expect(holdersFrom(bindings, ALL_ACTIVE, SETTINGS.routing.policy, ['gina']).ownerId).toBe(
      'gus',
    );
  });

  it('ignores revoked bindings and inactive users; the earliest binding wins', () => {
    const list = [
      binding('alice', 'person_a', 1, true),
      binding('dave', 'person_a', 3),
      binding('carol', 'person_a', 2),
    ];
    expect(pickHolder(list, ALL_ACTIVE, 'person_a', new Set())).toBe('carol');
    expect(pickHolder(list, new Set(['alice', 'dave']), 'person_a', new Set())).toBe('dave');
  });

  it('the owner is never also the backup', () => {
    const one = [binding('bob', 'person_b', 1), binding('bob', 'second_approver', 2)];
    const holders = holdersFrom(one, ALL_ACTIVE, SETTINGS.routing.technical, []);
    expect(holders).toEqual({ ownerId: 'bob', backupOwnerId: null, hasGovernance: false });
  });

  it('a step with no holder is skipped; nobody at all → unrouted at governance', () => {
    const onlyBackup = holdersFrom(
      [binding('bob', 'person_b', 1)],
      ALL_ACTIVE,
      SETTINGS.routing.intent,
      [],
    );
    expect(firstStep(onlyBackup)).toBe('backup');
    const nobody = holdersFrom([], ALL_ACTIVE, SETTINGS.routing.intent, []);
    expect(firstStep(nobody)).toBe('governance');
    expect(isUnrouted(nobody)).toBe(true);
    const governanceOnly = holdersFrom(
      [binding('gina', 'governance', 1)],
      ALL_ACTIVE,
      SETTINGS.routing.intent,
      [],
    );
    expect(firstStep(governanceOnly)).toBe('governance');
    expect(isUnrouted(governanceOnly)).toBe(false);
  });
});

describe('notices (Ch.6 §6.4 "Notify", codes table §6.3)', () => {
  const roles = (list: { audienceRole: string; kind: string; step: string }[]) =>
    list.map((n) => `${n.kind}/${n.step}/${n.audienceRole}`);

  it('a Critical escalation tells governance at once, with Person A and B', () => {
    expect(roles(raisedNotices('technical', 'critical', 'owner', SETTINGS))).toEqual([
      'raised/owner/person_b',
      'raised/owner/governance',
      'raised/owner/person_a',
    ]);
  });

  it('a Low escalation tells its owner role and Person A only', () => {
    expect(roles(raisedNotices('technical', 'low', 'owner', SETTINGS))).toEqual([
      'raised/owner/person_b',
      'raised/owner/person_a',
    ]);
  });

  it('clock effects tell the step holders; Critical past resolve starts the incident notice', () => {
    const at = new Date();
    expect(
      roles(clockNotices({ kind: 'reminded', at, step: 'owner' }, 'intent', SETTINGS)),
    ).toEqual(['reminder/owner/person_a']);
    expect(
      roles(
        clockNotices({ kind: 'step_changed', at, from: 'owner', to: 'backup' }, 'intent', SETTINGS),
      ),
    ).toEqual(['step_changed/backup/person_b', 'step_changed/backup/person_a']);
    expect(roles(clockNotices({ kind: 'governance_overdue', at }, 'intent', SETTINGS))).toEqual([
      'ack_overdue/governance/governance',
    ]);
    expect(
      roles(
        clockNotices(
          { kind: 'resolve_overdue', at, from: 'owner', incident: true },
          'security',
          SETTINGS,
        ),
      ),
    ).toEqual([
      'resolve_overdue/governance/governance',
      'resolve_overdue/governance/person_b',
      'incident_due/governance/governance',
    ]);
  });
});

describe('decision packet: codes, IDs, one hash, one link (ADR-M28 §2.3)', () => {
  it('keeps exactly the declared fields', () => {
    const packet = checkPacket({
      subject_kind: 'plan',
      subject_sha256: HASH,
      gate: 'G5',
      reason_code: 'budget_exceeded',
      recommendation: 'modify',
      ref: 'https://github.com/acme/repo/issues/7#issuecomment-1',
    });
    expect(packet).toMatchObject({ subject_kind: 'plan', gate: 'G5' });
    expect(Object.isFrozen(packet)).toBe(true);
  });

  it.each([
    ['missing hash', { subject_kind: 'plan' }],
    ['free text field', { subject_kind: 'plan', subject_sha256: HASH, goal: 'fix the bug' }],
    ['unknown subject', { subject_kind: 'email', subject_sha256: HASH }],
    ['http link', { subject_kind: 'plan', subject_sha256: HASH, ref: 'http://x.example' }],
    ['link with a space', { subject_kind: 'plan', subject_sha256: HASH, ref: 'https://a b' }],
    ['link with an address', { subject_kind: 'plan', subject_sha256: HASH, ref: 'https://a@b' }],
    ['null optional field', { subject_kind: 'plan', subject_sha256: HASH, gate: null }],
    ['bad run ID', { subject_kind: 'plan', subject_sha256: HASH, run_id: 'run-1' }],
  ])('refuses %s', (_name, input) => {
    expect(() => checkPacket(input)).toThrow(
      expect.objectContaining({ code: 'invalid_packet' }) as EscalationError,
    );
  });
});

describe('freeze rule (QUESTIONS #76)', () => {
  const base = { status: 'open' as const, ack_missed_at: null };

  it('pause, contain and incident freeze at once; observe and notify only after a missed ack', () => {
    expect(isFreezing({ ...base, response_level: 'pause' })).toBe(true);
    expect(isFreezing({ ...base, response_level: 'contain' })).toBe(true);
    expect(isFreezing({ ...base, response_level: 'incident' })).toBe(true);
    expect(isFreezing({ ...base, response_level: 'observe' })).toBe(false);
    expect(isFreezing({ ...base, response_level: 'notify' })).toBe(false);
    expect(isFreezing({ ...base, response_level: 'notify', ack_missed_at: new Date() })).toBe(true);
  });

  it('keeps freezing until closed', () => {
    expect(isFreezing({ ...base, status: 'resolved', response_level: 'pause' })).toBe(true);
    expect(isFreezing({ ...base, status: 'closed', response_level: 'pause' })).toBe(false);
  });
});

describe('escalation codes (template T16)', () => {
  it('formats and parses ESC-YYYY-NNNN', () => {
    expect(formatEscalationCode(2026, 7)).toBe('ESC-2026-0007');
    expect(formatEscalationCode(2026, 12345)).toBe('ESC-2026-12345');
    expect(parseEscalationCode('ESC-2026-0007')).toEqual({ year: 2026, number: 7 });
    expect(parseEscalationCode('INT-2026-0007')).toBeUndefined();
    expect(() => formatEscalationCode(2026, 0)).toThrow(RangeError);
  });
});
