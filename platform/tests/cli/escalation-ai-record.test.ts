// `sdlc escalation …` (B04 AC4, ADR-M28 §2.7) and `sdlc ai-record …` (B04 AC5, ADR-M32 §2.4)
// against a mocked API, and a sweep that the token never reaches the output.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { aiRecordBody, decisionBody, escalationBody, intentBody, meBody } from './fixtures.js';
import { apiError, TOKEN, useHarness, type Routes } from './harness.js';

const harness = useHarness();
const ESC = '/v1/escalations/ESC-2026-0003';

describe('sdlc escalation', () => {
  it('lists with filters', async () => {
    const h = await harness({
      routes: { 'GET /v1/escalations': { status: 200, body: { items: [escalationBody()] } } },
    });
    expect(
      await h.run(['escalation', 'list', '--intent', 'int-2026-0007', '--status', 'open']),
    ).toBe(EXIT.ok);
    expect(Object.fromEntries(h.requests[0]?.url.searchParams ?? [])).toEqual({
      intent: 'INT-2026-0007',
      status: 'open',
    });
    expect(h.out).toEqual([
      t('cli.escalation.line', {
        code: 'ESC-2026-0003',
        intent: 'INT-2026-0007',
        status: 'open',
        severity: 'medium',
        level: 'notify',
        route: 'intent',
        step: 'owner',
        freezes: '-',
      }),
    ]);
  });

  it('marks an escalation that freezes its intent', async () => {
    const h = await harness({
      routes: {
        'GET /v1/escalations': {
          status: 200,
          body: { items: [escalationBody({ response_level: 'pause' })] },
        },
      },
    });
    expect(await h.run(['escalation', 'list'])).toBe(EXIT.ok);
    expect(h.out[0]).toContain(t('cli.escalation.frozen'));
  });

  it('shows one escalation', async () => {
    const h = await harness({
      routes: { [`GET ${ESC}`]: { status: 200, body: escalationBody() } },
    });
    expect(await h.run(['escalation', 'show', 'esc-2026-0003'])).toBe(EXIT.ok);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain('ESC-2026-0003');
  });

  it('acknowledges', async () => {
    const h = await harness({
      routes: {
        [`POST ${ESC}/ack`]: { status: 200, body: escalationBody({ status: 'acknowledged' }) },
      },
    });
    expect(await h.run(['escalation', 'ack', 'ESC-2026-0003'])).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      t('cli.escalation.acknowledged', { code: 'ESC-2026-0003', status: 'acknowledged' }),
    );
  });

  it.each([
    ['resume', 'resume'],
    ['modify', 'modify'],
    ['roll-back', 'roll_back'],
    ['terminate', 'terminate'],
    ['escalate', 'escalate_further'],
  ])('decide %s sends %s', async (word, decision) => {
    const h = await harness({
      routes: {
        [`POST ${ESC}/decisions`]: { status: 201, body: escalationBody({ status: 'resolved' }) },
      },
    });
    expect(await h.run(['escalation', 'decide', 'ESC-2026-0003', word])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ decision });
    expect(h.out[0]).toBe(
      t('cli.escalation.decided', { code: 'ESC-2026-0003', status: 'resolved' }),
    );
  });

  it('sends the actions, the budget increase and the reason', async () => {
    const h = await harness({
      routes: { [`POST ${ESC}/decisions`]: { status: 201, body: escalationBody() } },
    });
    expect(
      await h.run([
        'escalation',
        'decide',
        'ESC-2026-0003',
        'resume',
        '--actions',
        'run_resume,budget_increase,run_resume',
        '--budget-increase-usd',
        '1.25',
        '--reason-code',
        'budget_exceeded',
        '--reason-ref',
        'https://github.com/o/r/issues/12#issuecomment-2',
        '--json',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      decision: 'resume',
      actions: ['run_resume', 'budget_increase'],
      budget_increase_usd: '1.25',
      reason_code: 'budget_exceeded',
      reason_ref: 'https://github.com/o/r/issues/12#issuecomment-2',
    });
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ code: 'ESC-2026-0003' });
  });

  it('shows a refused decision (exit 1)', async () => {
    const h = await harness({
      routes: { [`POST ${ESC}/decisions`]: apiError(422, 'escalation_decision_not_allowed') },
    });
    expect(await h.run(['escalation', 'decide', 'ESC-2026-0003', 'resume'])).toBe(EXIT.failed);
    expect(h.err[0]).toBe(
      t('cli.api.refused', {
        code: 'escalation_decision_not_allowed',
        message: t('api.error.escalation_decision_not_allowed'),
      }),
    );
  });

  it.each([
    [['escalation']],
    [['escalation', 'show']],
    [['escalation', 'show', 'ESC-1']],
    [['escalation', 'decide', 'ESC-2026-0003']],
    [['escalation', 'decide', 'ESC-2026-0003', 'approve']],
    [['escalation', 'decide', 'ESC-2026-0003', 'resume', '--actions', 'deploy']],
    [['escalation', 'decide', 'ESC-2026-0003', 'resume', '--budget-increase-usd', 'lots']],
    [['escalation', 'list', '--status', 'pending']],
    [['escalation', 'list', '--intent', 'nope']],
  ])('prints the escalation usage and exits 2 for %j', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.escalation.usage')]);
    expect(h.requests).toEqual([]);
  });
});

describe('sdlc ai-record', () => {
  const PATH = '/v1/projects/pilot/ai-record';
  const SET = [
    'ai-record',
    'set',
    '--project',
    'pilot',
    '--expected-version',
    '2',
    '--ai-allowed',
    'yes',
    '--classes',
    'public, internal',
    '--prod-logs',
    'no',
    '--disclosure',
    'standard_note',
  ];

  it('shows the record', async () => {
    const h = await harness({ routes: { [`GET ${PATH}`]: { status: 200, body: aiRecordBody() } } });
    expect(await h.run(['ai-record', 'show', '--project', 'pilot'])).toBe(EXIT.ok);
    expect(h.out[0]).toContain('pilot');
  });

  it('says when the project has no record (exit 1)', async () => {
    const h = await harness({ routes: { [`GET ${PATH}`]: apiError(404, 'ai_record_not_found') } });
    expect(await h.run(['ai-record', 'show', '--project', 'pilot'])).toBe(EXIT.failed);
    expect(h.err).toEqual([
      t('cli.api.refused', {
        code: 'ai_record_not_found',
        message: t('api.error.ai_record_not_found'),
      }),
    ]);
  });

  it('puts the record with the expected version', async () => {
    const h = await harness({ routes: { [`PUT ${PATH}`]: { status: 200, body: aiRecordBody() } } });
    expect(
      await h.run([
        ...SET,
        '--confirmed-at',
        '2026-10-01',
        '--record-ref',
        'https://example.test/ai-record.md',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      expected_version: 2,
      ai_allowed: 'yes',
      allowed_data_classes: ['public', 'internal'],
      prod_logs_allowed: 'no',
      disclosure_format: 'standard_note',
      confirmed_at: '2026-10-01',
      record_ref: 'https://example.test/ai-record.md',
    });
  });

  it('sends `none` as no classes and null for missing optional fields', async () => {
    const h = await harness({ routes: { [`PUT ${PATH}`]: { status: 200, body: aiRecordBody() } } });
    const args = [...SET];
    args[9] = 'none';
    expect(await h.run(args)).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toMatchObject({
      allowed_data_classes: [],
      confirmed_at: null,
      record_ref: null,
    });
  });

  it('reports a version conflict (exit 1)', async () => {
    const h = await harness({
      routes: { [`PUT ${PATH}`]: apiError(409, 'ai_record_version_conflict') },
    });
    expect(await h.run(SET)).toBe(EXIT.failed);
    expect(h.err[0]).toBe(
      t('cli.api.refused', {
        code: 'ai_record_version_conflict',
        message: t('api.error.ai_record_version_conflict'),
      }),
    );
  });

  it.each([
    [['ai-record']],
    [['ai-record', 'show']],
    [['ai-record', 'show', '--project', 'Pilot!']],
    [SET.slice(0, -2)],
    [[...SET.slice(0, 5), 'two', ...SET.slice(6)]],
    [[...SET, '--tenant', 'x']],
  ])('prints the AI record usage and exits 2 for %j', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.ai_record.usage')]);
    expect(h.requests).toEqual([]);
  });
});

describe('the token never reaches the output', () => {
  const routes: Routes = {
    'GET /v1/me': { status: 200, body: meBody() },
    'GET /v1/intents': { status: 200, body: { items: [intentBody()], next_cursor: null } },
    'POST /v1/intents': apiError(401, 'unauthorized'),
    'POST /v1/intents/INT-2026-0007/gates/G1/decisions': { status: 201, body: decisionBody() },
    'GET /v1/escalations': apiError(500, 'internal'),
    'GET /v1/projects/pilot/ai-record': { status: 200, body: { bad: true } },
  };

  it.each([
    [['whoami']],
    [['whoami', '--json']],
    [['intent', 'list', '--json']],
    [
      [
        'intent',
        'create',
        '--project',
        'p',
        '--title',
        't',
        '--risk',
        'low',
        '--data-class',
        'public',
      ],
    ],
    [['gate', 'approve', 'G1', 'INT-2026-0007', '--json']],
    [['escalation', 'list', '--json']],
    [['ai-record', 'show', '--project', 'pilot']],
    [['logout']],
  ])('%j', async (argv) => {
    const h = await harness({ routes });
    await h.run(argv);
    expect([...h.out, ...h.err].join('\n')).not.toContain(TOKEN);
  });
});
