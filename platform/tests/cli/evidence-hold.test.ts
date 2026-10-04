// `sdlc admin evidence hold|release|show <INT>` over the API (E05, ADR-M51, QUESTIONS #235) against
// a mocked API, and the parser of `sdlc ops retention report` (counts only).
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { parseRetentionCommand } from '../../apps/cli/src/commands/ops-retention.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();
const HOLD = {
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  held_by: '11111111-2222-4333-8444-555555555555',
  reason_ref: 'https://example.com/case/1',
  created_at: '2026-10-04T10:00:00.000Z',
  released_at: null,
  released_by: null,
};

describe('sdlc admin evidence', () => {
  it('holds an intent with an optional link', async () => {
    const h = await harness({
      routes: {
        'PUT /v1/intents/INT-2026-0001/evidence-hold': { status: 201, body: { hold: HOLD } },
      },
    });
    expect(
      await h.run([
        'admin',
        'evidence',
        'hold',
        'INT-2026-0001',
        '--ref',
        'https://example.com/case/1',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ reason_ref: 'https://example.com/case/1' });
    expect(h.out).toEqual([
      t('cli.admin.evidence.held', {
        intent: 'INT-2026-0001',
        id: HOLD.id,
        created_at: HOLD.created_at,
        released_at: '-',
        ref: HOLD.reason_ref,
      }),
    ]);
  });

  it('releases and shows', async () => {
    const released = {
      ...HOLD,
      released_at: '2026-10-05T10:00:00.000Z',
      released_by: HOLD.held_by,
    };
    const h = await harness({
      routes: {
        'DELETE /v1/intents/INT-2026-0001/evidence-hold': { status: 200, body: { hold: released } },
        'GET /v1/intents/INT-2026-0001/evidence-hold': {
          status: 200,
          body: { intent: 'INT-2026-0001', active: null, history: [released] },
        },
      },
    });
    expect(await h.run(['admin', 'evidence', 'release', 'INT-2026-0001'])).toBe(EXIT.ok);
    expect(await h.run(['admin', 'evidence', 'show', 'INT-2026-0001', '--json'])).toBe(EXIT.ok);
    expect(h.out[0]).toContain('2026-10-05T10:00:00.000Z');
    expect(JSON.parse(h.out[1]!)).toMatchObject({ active: null });
  });

  it('shows the refusal from the catalog and needs exactly one intent', async () => {
    const h = await harness({
      routes: {
        'PUT /v1/intents/INT-2026-0001/evidence-hold': apiError(409, 'evidence_hold_exists'),
      },
    });
    expect(await h.run(['admin', 'evidence', 'hold', 'INT-2026-0001'])).toBe(EXIT.failed);
    expect(await h.run(['admin', 'evidence', 'hold'])).toBe(EXIT.usage);
  });
});

describe('sdlc ops retention report (parser)', () => {
  it('needs a tenant; the grace is a number', () => {
    expect(parseRetentionCommand(['report', '--tenant', 'internal'])).toMatchObject({
      command: 'report',
    });
    expect(parseRetentionCommand(['report'])).toBeUndefined();
    expect(parseRetentionCommand(['purge', '--tenant', 'internal'])).toBeUndefined();
    expect(
      parseRetentionCommand(['report', '--tenant', 'x', '--archive-grace-days', 'soon']),
    ).toBeUndefined();
  });
});
