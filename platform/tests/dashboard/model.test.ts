// U01 AC6: the dashboard's data mapping (design/ADR-M54 §2.5). Pure functions with a pinned clock.
import fs from 'node:fs';
import path from 'node:path';

import {
  cleanText,
  type CostReportView,
  type EscalationView,
  type GateMetricsView,
  type IntentView,
} from '@sdlc/api-schemas';
import { describe, expect, it } from 'vitest';

import { apiPath, segment } from '../../apps/dashboard/src/api/client.js';
import { codeClass } from '../../apps/dashboard/src/components/class-name.js';
import { escalationRows } from '../../apps/dashboard/src/model/escalations.js';
import { holdOf } from '../../apps/dashboard/src/model/hold.js';
import {
  buildBoard,
  gateTrack,
  intentLinks,
  longestWait,
} from '../../apps/dashboard/src/model/intents.js';
import {
  costBars,
  gateWaitBars,
  groupDigits,
  roundUsd,
  share,
  waitScale,
} from '../../apps/dashboard/src/model/numbers.js';
import { href, intentHref, parseRoute } from '../../apps/dashboard/src/model/route.js';
import { dueState, durationLabel, secondsSince } from '../../apps/dashboard/src/model/time.js';
import { repoRoot } from '../workspace/helpers';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const inMs = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function intent(over: Partial<IntentView> = {}): IntentView {
  return {
    id: over.id ?? 'i-1',
    code: 'INT-2026-0001',
    project: { id: 'p', slug: 'pilot', repo_full_name: 'harryforge/pilot-order-inventory' },
    title: 'Add Japanese labels',
    description: '',
    risk_tier: 'low',
    data_class: 'internal',
    max_autonomy: 'L2',
    budget_usd: '2.500000',
    status: 'in_gate',
    current_gate: 'G2',
    gate_entered_at: ago(2 * HOUR),
    waiting_reason: 'decision',
    waiting_cause: null,
    waiting_since: ago(2 * HOUR),
    waiting_until: null,
    issue_number: 12,
    pr_number: null,
    created_by: 'u',
    created_at: ago(48 * HOUR),
    updated_at: ago(HOUR),
    ...over,
  };
}

function escalation(over: Partial<EscalationView> = {}): EscalationView {
  return {
    id: over.id ?? 'e-1',
    code: 'ESC-2026-0001',
    intent: { id: 'i-1', code: 'INT-2026-0001' },
    run_id: null,
    trigger: 'time',
    route: 'intent',
    severity: 'medium',
    response_level: 'notify',
    status: 'open',
    freezes_intent: false,
    current_step: 'owner',
    owner_id: 'u',
    backup_owner_id: null,
    owner_role: 'person_a',
    backup_role: 'person_b',
    step_role: 'person_a',
    packet: {},
    ack_due_at: inMs(2 * HOUR),
    step_due_at: inMs(2 * HOUR),
    resolve_due_at: inMs(24 * HOUR),
    acknowledged_by: null,
    acknowledged_at: null,
    decision: null,
    decided_by: null,
    decided_at: null,
    closed_at: null,
    created_at: ago(HOUR),
    ...over,
  };
}

describe('time', () => {
  it('measures waits from the gate entry, never negative', () => {
    expect(secondsSince(ago(90_000), NOW)).toBe(90);
    expect(secondsSince(inMs(5_000), NOW)).toBe(0);
    expect(secondsSince(null, NOW)).toBeNull();
    expect(secondsSince('not a date', NOW)).toBeNull();
  });

  it('labels durations by their largest unit', () => {
    expect(durationLabel(3 * 86_400 + 4 * 3_600)).toEqual({
      key: 'dashboard.duration.days_hours',
      params: { days: 3, hours: 4 },
    });
    expect(durationLabel(5 * 3_600 + 12 * 60).key).toBe('dashboard.duration.hours_minutes');
    expect(durationLabel(7 * 60).params).toEqual({ minutes: 7 });
    expect(durationLabel(30).key).toBe('dashboard.duration.under_minute');
  });

  it('tells overdue, soon and later apart; no clock is none', () => {
    expect(dueState(ago(10 * 60_000), NOW)).toEqual({ state: 'overdue', seconds: 600 });
    expect(dueState(inMs(30 * 60_000), NOW).state).toBe('soon');
    expect(dueState(inMs(2 * HOUR), NOW).state).toBe('later');
    expect(dueState(null, NOW).state).toBe('none');
  });
});

describe('the intents board', () => {
  it('puts open intents in their gate lane, the longest wait first; finished ones stay off', () => {
    const lanes = buildBoard(
      [
        intent({ id: 'a', gate_entered_at: ago(HOUR) }),
        intent({ id: 'b', gate_entered_at: ago(5 * HOUR) }),
        intent({ id: 'c', current_gate: 'G7', gate_entered_at: ago(30 * HOUR) }),
        intent({ id: 'd', status: 'draft', current_gate: null, gate_entered_at: null }),
        intent({ id: 'e', status: 'done', current_gate: null }),
        intent({ id: 'f', status: 'paused', current_gate: 'G5' }),
      ],
      [],
      NOW,
    );
    expect(lanes.map((l) => l.id)).toEqual([
      'draft',
      'G1',
      'G2',
      'G3',
      'G4',
      'G5',
      'G6',
      'G7',
      'G8',
    ]);
    const byLane = Object.fromEntries(lanes.map((l) => [l.id, l.cards.map((c) => c.intent.id)]));
    expect(byLane).toMatchObject({ draft: ['d'], G2: ['b', 'a'], G5: ['f'], G7: ['c'], G1: [] });
    expect(lanes.flatMap((l) => l.cards).some((c) => c.intent.id === 'e')).toBe(false);
    expect(lanes[0]!.cards[0]!.waitedSeconds).toBeNull();
    expect(longestWait(lanes)).toBe(30 * 3_600);
  });

  it('marks an intent past its gate deadline (open time escalation) and a frozen one', () => {
    const cardOf = (esc: EscalationView[]) =>
      buildBoard([intent({ id: 'i-1' })], esc, NOW).find((l) => l.id === 'G2')!.cards[0]!;
    expect(cardOf([escalation()])).toMatchObject({ overdue: true, frozen: false });
    expect(cardOf([escalation({ trigger: 'out_of_scope', freezes_intent: true })])).toMatchObject({
      overdue: false,
      frozen: true,
    });
    // A closed escalation no longer counts.
    expect(cardOf([escalation({ status: 'closed', freezes_intent: true })])).toMatchObject({
      overdue: false,
      frozen: false,
    });
  });

  it('draws the gate track: passed, current, ahead; done passes every gate', () => {
    expect(gateTrack({ current_gate: 'G3', status: 'in_gate' }).map((g) => g.state)).toEqual([
      'passed',
      'passed',
      'current',
      'ahead',
      'ahead',
      'ahead',
      'ahead',
      'ahead',
    ]);
    expect(
      gateTrack({ current_gate: null, status: 'done' }).every((g) => g.state === 'passed'),
    ).toBe(true);
    expect(
      gateTrack({ current_gate: null, status: 'draft' }).every((g) => g.state === 'ahead'),
    ).toBe(true);
  });

  it('links the issue and the pull request on GitHub; refuses an odd repository name', () => {
    expect(intentLinks(intent({ pr_number: 7 }))).toEqual({
      issue: 'https://github.com/harryforge/pilot-order-inventory/issues/12',
      pullRequest: 'https://github.com/harryforge/pilot-order-inventory/pull/7',
    });
    for (const repo of ['evil.example/x/y', '../x', 'a/b?c', 'javascript:alert(1)']) {
      const odd = intent({ project: { id: 'p', slug: 's', repo_full_name: repo } });
      expect(intentLinks(odd), repo).toEqual({ issue: null, pullRequest: null });
    }
  });
});

describe('escalations', () => {
  it('shows open and acknowledged ones, overdue first, then the nearest clock', () => {
    const rows = escalationRows(
      [
        escalation({ id: 'later', code: 'ESC-2026-0003', step_due_at: inMs(5 * HOUR) }),
        escalation({ id: 'over', code: 'ESC-2026-0002', step_due_at: ago(HOUR) }),
        escalation({
          id: 'acked',
          code: 'ESC-2026-0004',
          status: 'acknowledged',
          resolve_due_at: inMs(20 * 60_000),
        }),
        escalation({ id: 'closed', status: 'closed' }),
        escalation({
          id: 'noclock',
          code: 'ESC-2026-0005',
          status: 'acknowledged',
          resolve_due_at: null,
        }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.escalation.id)).toEqual(['over', 'acked', 'later', 'noclock']);
    expect(rows[1]).toMatchObject({ clock: 'resolve', state: 'soon' });
    expect(rows[0]).toMatchObject({ clock: 'acknowledge', state: 'overdue', seconds: 3_600 });
  });
});

describe('numbers', () => {
  it('rounds money on its digits, half up, never as a float', () => {
    expect(roundUsd('12.345678')).toBe('12.35');
    expect(roundUsd('0.004999')).toBe('0.00');
    expect(roundUsd('9.995000')).toBe('10.00');
    expect(roundUsd('123456789012345.999999')).toBe('123456789012346.00');
    expect(roundUsd('nonsense')).toBe('nonsense');
  });

  it('groups token sums beyond 2^53', () => {
    expect(groupDigits('12345678901234567890')).toBe('12,345,678,901,234,567,890');
    expect(share('5', '10')).toBe(0.5);
    expect(share('5', '0')).toBe(0);
  });

  it('orders cost rows by cost and scales them to the largest', () => {
    const amounts = {
      calls: 1,
      input_tokens: '10',
      output_tokens: '5',
      cached_input_tokens: '0',
      wasted_tokens: '0',
    };
    const report = {
      rows: [
        { ...amounts, key: 'INT-2026-0001', cost_usd: '1.000000', wasted_cost_usd: '0.000000' },
        { ...amounts, key: 'INT-2026-0002', cost_usd: '4.000000', wasted_cost_usd: '1.000000' },
      ],
    } as unknown as CostReportView;
    const bars = costBars(report);
    expect(bars.map((b) => [b.key, b.costShare, b.wastedShare, b.tokens])).toEqual([
      ['INT-2026-0002', 1, 0.25, '15'],
      ['INT-2026-0001', 0.25, 0, '15'],
    ]);
  });

  it('turns gate metrics into bars against one scale', () => {
    const stats = (avg: number | null, max: number | null) => ({
      count: avg === null ? 0 : 2,
      avg_seconds: avg,
      max_seconds: max,
      p50_seconds: avg,
      p90_seconds: max,
    });
    const metrics = {
      rows: [
        {
          project: 'pilot',
          gate: 'G3',
          first_round: stats(600, 1200),
          after_changes: stats(null, null),
          auto_passed: 1,
          open: { count: 1, oldest_seconds: 3000 },
        },
      ],
    } as unknown as GateMetricsView;
    const bars = gateWaitBars(metrics);
    expect(bars[0]).toMatchObject({ gate: 'G3', decided: 2, avgSeconds: 600, openCount: 1 });
    expect(waitScale(bars)).toBe(3000);
  });
});

describe('routes and API paths', () => {
  it('parses the hash route; an unknown or bad route falls back to the board', () => {
    expect(parseRoute('#/intents/INT-2026-0007')).toMatchObject({
      name: 'intent',
      code: 'INT-2026-0007',
    });
    expect(parseRoute('#/numbers?project=pilot&by=model').query.get('by')).toBe('model');
    expect(parseRoute('#/intents/<script>').name).toBe('intents');
    expect(parseRoute('').name).toBe('intents');
    expect(href('intents', { project: 'pilot', show: undefined })).toBe('#/intents?project=pilot');
  });

  it('builds /v1 paths only, every value encoded', () => {
    expect(apiPath('/v1/intents', { project: 'a b', limit: 100, cursor: undefined })).toBe(
      '/v1/intents?project=a+b&limit=100',
    );
    expect(segment('INT-2026-0001/../x')).toBe('INT-2026-0001%2F..%2Fx');
    expect(() => apiPath('https://evil.example/v1/x')).toThrow();
    expect(() => apiPath('/health/live')).toThrow();
  });
});

describe('server text and links', () => {
  it('cleans control, bidi, zero-width and separator characters (built from code points)', () => {
    const unsafe = [0x1b, 0x9b, 0x61c, 0x200b, 0x200e, 0x2028, 0x202e, 0x2060, 0x2067, 0xfeff];
    const dirty = `a${unsafe.map((c) => String.fromCharCode(c)).join('b')}z`;
    expect(cleanText(dirty)).toBe(`a ${'b '.repeat(unsafe.length - 1)}z`);
  });

  it('the cleaner is written in ASCII escapes only (no invisible character in the source)', () => {
    const file = path.join(repoRoot(), 'platform/packages/api-schemas/src/text.ts');
    const text = fs.readFileSync(file, 'utf8');
    const pattern = text.split('\n').find((line) => line.trim().startsWith('/['))!;
    expect(/^[\x20-\x7e]+$/.test(pattern)).toBe(true);
  });

  it('links an intent only by a real intent code', () => {
    expect(intentHref('INT-2026-0007')).toBe('#/intents/INT-2026-0007');
    expect(intentHref('INT-2026-0007?x#y')).toBe('#/intents');
    expect(intentHref('../evil')).toBe('#/intents');
  });

  it('CSS classes from codes hold no space or extra class', () => {
    expect(codeClass('decision', 'approve')).toBe('decision-approve');
    expect(codeClass('mode', 'HITL card-overdue')).toBe('mode-hitlcardoverdue');
  });
});

describe('what holds an intent (U02)', () => {
  it('shows a hold with its catalog labels; `decision` is not a hold', () => {
    expect(holdOf(intent())).toBeNull();
    expect(holdOf(intent({ waiting_reason: null, waiting_since: null }))).toBeNull();
    expect(
      holdOf(intent({ waiting_reason: 'g4_check', waiting_cause: 'agent_not_active' })),
    ).toMatchObject({
      reason: { key: 'intent.waiting.g4_check' },
      cause: { key: 'intent.waiting_cause.agent_not_active' },
    });
    const window = holdOf(
      intent({ waiting_reason: 'hotl_block_window', waiting_until: inMs(HOUR) }),
    );
    expect(window).toMatchObject({ reason: { key: 'intent.waiting.hotl_block_window' } });
    expect(window?.until).toBe(inMs(HOUR));
  });

  it('a reason or cause the dashboard does not know yet is shown as its code', () => {
    expect(
      holdOf(intent({ waiting_reason: 'some_new_reason', waiting_cause: 'some_new_cause' })),
    ).toMatchObject({ reason: { code: 'some_new_reason' }, cause: { code: 'some_new_cause' } });
  });
});
