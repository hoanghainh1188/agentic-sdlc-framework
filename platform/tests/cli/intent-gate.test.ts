// `sdlc intent …` and `sdlc gate …` against a mocked API (B04 AC1–AC3, FR-20).
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { refusalReasonMessage } from '../../packages/core/src/index.js';
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { decisionBody, intentBody, intentDetailBody } from './fixtures.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();

const CREATE = [
  'intent',
  'create',
  '--project',
  'pilot',
  '--title',
  'Add Japanese labels',
  '--risk',
  'low',
  '--data-class',
  'internal',
];

describe('sdlc intent create', () => {
  it('posts the intent and prints the summary', async () => {
    const h = await harness({
      routes: { 'POST /v1/intents': { status: 201, body: intentBody() } },
    });
    expect(await h.run([...CREATE, '--budget', '2.5', '--issue', '12'])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      project: 'pilot',
      title: 'Add Japanese labels',
      description: '',
      risk_tier: 'low',
      data_class: 'internal',
      budget_usd: '2.5',
      issue_number: 12,
    });
    expect(h.out).toEqual([
      t('cli.intent.created', {
        code: 'INT-2026-0007',
        project: 'pilot',
        status: 'in_gate',
        risk: 'low',
        data_class: 'internal',
        max_autonomy: 'L2',
        budget: '2.500000',
      }),
    ]);
  });

  it('reads the description from a file', async () => {
    const h = await harness({
      routes: { 'POST /v1/intents': { status: 201, body: intentBody() } },
    });
    const file = join(h.home, 'description.md');
    await writeFile(file, 'Line one\nLine two');
    expect(await h.run([...CREATE, '--description-file', file])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toMatchObject({ description: 'Line one\nLine two' });
  });

  it('refuses a description longer than the API allows', async () => {
    const h = await harness();
    expect(await h.run([...CREATE, '--description', 'x'.repeat(10_001)])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.intent.description_too_long', { max: 10_000 })]);
    expect(h.requests).toEqual([]);
  });

  it.each([
    [['intent', 'create', '--project', 'pilot']],
    [[...CREATE.slice(0, -1), 'secret']],
    [[...CREATE.slice(0, 7), 'extreme', ...CREATE.slice(8)]],
    [[...CREATE, '--budget', '1,5']],
    [[...CREATE, '--issue', '0']],
    [[...CREATE, '--description', 'a', '--description-file', 'b']],
    [[...CREATE, 'extra']],
    [['intent']],
    [['intent', 'delete']],
  ])('prints the intent usage and exits 2 for %j', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.intent.usage')]);
    expect(h.requests).toEqual([]);
  });

  it('maps a 403 to exit 1 with the catalog message', async () => {
    const h = await harness({ routes: { 'POST /v1/intents': apiError(403, 'forbidden') } });
    expect(await h.run(CREATE)).toBe(EXIT.failed);
    expect(h.err).toEqual([
      t('cli.api.refused', { code: 'forbidden', message: t('api.error.forbidden') }),
    ]);
  });

  it('shows the field details of a 400 and exits 2', async () => {
    const h = await harness({
      routes: {
        'POST /v1/intents': apiError(400, 'invalid_request', {
          details: [{ path: 'body.title', issue: 'too_big' }],
        }),
      },
    });
    expect(await h.run(CREATE)).toBe(EXIT.usage);
    expect(h.err[1]).toBe(t('cli.api.detail', { path: 'body.title', issue: 'too_big' }));
  });

  it('exits 3 on a server error', async () => {
    const h = await harness({ routes: { 'POST /v1/intents': apiError(500, 'internal') } });
    expect(await h.run(CREATE)).toBe(EXIT.error);
  });

  it('shows the server text for an error code this CLI does not know', async () => {
    const h = await harness({ routes: { 'POST /v1/intents': apiError(409, 'brand_new_code') } });
    expect(await h.run(CREATE)).toBe(EXIT.failed);
    expect(h.err).toEqual([
      t('cli.api.refused', { code: 'brand_new_code', message: 'server text for brand_new_code' }),
    ]);
  });

  it('prints the error envelope as JSON on stderr with --json', async () => {
    const h = await harness({
      routes: { 'POST /v1/intents': apiError(409, 'issue_already_linked') },
    });
    expect(await h.run([...CREATE, '--json'])).toBe(EXIT.failed);
    expect(h.out).toEqual([]);
    expect(JSON.parse(h.err.join('\n'))).toEqual({
      error: { code: 'issue_already_linked', message: 'server text for issue_already_linked' },
    });
  });
});

describe('sdlc intent list and show', () => {
  it('lists with filters and shows the next cursor', async () => {
    const h = await harness({
      routes: {
        'GET /v1/intents': { status: 200, body: { items: [intentBody()], next_cursor: 'abc' } },
      },
    });
    expect(
      await h.run(['intent', 'list', '--project', 'pilot', '--status', 'in_gate', '--limit', '5']),
    ).toBe(EXIT.ok);
    expect(Object.fromEntries(h.requests[0]?.url.searchParams ?? [])).toEqual({
      project: 'pilot',
      status: 'in_gate',
      limit: '5',
    });
    expect(h.out).toEqual([
      t('cli.intent.line', {
        code: 'INT-2026-0007',
        status: 'in_gate',
        gate: 'G2',
        risk: 'low',
        project: 'pilot',
        title: 'Add Japanese labels',
      }),
      t('cli.intent.more', { cursor: 'abc' }),
    ]);
  });

  it.each([
    [['intent', 'list', '--status', 'weird']],
    [['intent', 'list', '--limit', '101']],
    [['intent', 'show']],
    [['intent', 'show', 'INT-26-1']],
  ])('refuses %j', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.requests).toEqual([]);
  });

  it('cleans control characters out of server text before printing', async () => {
    const h = await harness({
      routes: {
        'GET /v1/intents': {
          status: 200,
          body: {
            items: [intentBody({ title: 'evil\u001b[2J\u202etitle\u009b' })],
            next_cursor: null,
          },
        },
      },
    });
    expect(await h.run(['intent', 'list'])).toBe(EXIT.ok);
    expect(h.out[0]).toContain('evil [2J title ');
    // eslint-disable-next-line no-control-regex
    expect(h.out.join('')).not.toMatch(/[\u001b\u202e\u009b]/);
  });

  it('escapes control characters in --json output', async () => {
    const h = await harness({
      routes: {
        'GET /v1/intents': {
          status: 200,
          body: { items: [intentBody({ title: 'a\u001bb\u009bc\u202ed' })], next_cursor: null },
        },
      },
    });
    expect(await h.run(['intent', 'list', '--json'])).toBe(EXIT.ok);
    const text = h.out.join('\n');
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u001b\u202e\u009b]/);
    expect(JSON.parse(text)).toMatchObject({ items: [{ title: 'a\u001bb\u009bc\u202ed' }] });
  });

  it('shows an intent by code (any case) with spec, plan and decisions', async () => {
    const h = await harness({
      routes: { 'GET /v1/intents/INT-2026-0007': { status: 200, body: intentDetailBody() } },
    });
    expect(await h.run(['intent', 'show', 'int-2026-0007'])).toBe(EXIT.ok);
    expect(h.out).toHaveLength(4);
    expect(h.out[3]).toBe(
      t('cli.intent.decision', {
        at: '2026-10-03T01:02:03.000Z',
        gate: 'G2',
        decision: 'approve',
        mode: 'HITL',
        actor: 'human',
        role: 'person_a',
        reason: '-',
        expires: '2026-10-10T01:02:03.000Z',
      }),
    );
  });

  it('refuses an answer that does not match the expected shape (exit 3)', async () => {
    const h = await harness({
      routes: { 'GET /v1/intents/INT-2026-0007': { status: 200, body: { code: 'x' } } },
    });
    expect(await h.run(['intent', 'show', 'INT-2026-0007'])).toBe(EXIT.error);
    expect(h.err).toEqual([t('cli.api.malformed')]);
  });
});

describe('sdlc gate', () => {
  const PATH = 'POST /v1/intents/INT-2026-0007/gates/G2/decisions';

  it.each([
    ['approve', 'approve'],
    ['reject', 'reject'],
    ['request-changes', 'request_changes'],
  ])('%s sends the decision %s', async (verb, decision) => {
    const h = await harness({ routes: { [PATH]: { status: 201, body: decisionBody() } } });
    expect(
      await h.run([
        'gate',
        verb,
        'g2',
        'INT-2026-0007',
        '--reason-code',
        'spec_unclear',
        '--reason-ref',
        'https://github.com/o/r/issues/12#issuecomment-1',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      decision,
      reason_code: 'spec_unclear',
      reason_ref: 'https://github.com/o/r/issues/12#issuecomment-1',
    });
  });

  it('prints the recorded decision', async () => {
    const h = await harness({ routes: { [PATH]: { status: 201, body: decisionBody() } } });
    expect(await h.run(['gate', 'approve', 'G2', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ decision: 'approve' });
    expect(h.out).toEqual([
      t('cli.gate.recorded', {
        decision: 'approve',
        gate: 'G2',
        intent: 'INT-2026-0007',
        mode: 'HITL',
        role: 'person_a',
        expires: '2026-10-10T01:02:03.000Z',
      }),
    ]);
  });

  it('shows a refusal with its reason from the catalog (exit 1)', async () => {
    const h = await harness({
      routes: { [PATH]: apiError(422, 'approval_refused', { reason: 'role_missing' }) },
    });
    expect(await h.run(['gate', 'approve', 'G2', 'INT-2026-0007'])).toBe(EXIT.failed);
    expect(h.err).toEqual([
      t('cli.api.refused', {
        code: 'approval_refused',
        message: t('api.error.approval_refused'),
      }),
      t('cli.api.reason', {
        reason: 'role_missing',
        message: refusalReasonMessage('role_missing'),
      }),
    ]);
  });

  it.each([
    [['gate', 'approve', 'G9', 'INT-2026-0007']],
    [['gate', 'approve', 'G2']],
    [['gate', 'approve', 'G2', 'INT-2026-0007', 'extra']],
    [['gate', 'bless', 'G2', 'INT-2026-0007']],
    [['gate', 'reject', 'G2', 'INT-2026-0007', '--reason-code', 'because']],
    [['gate', 'reject', 'G2', 'INT-2026-0007', '--reason-ref', 'http://x.test/a']],
    [['gate', 'reject', 'G2', 'INT-2026-0007', '--reason', 'free text']],
    [['gate', 'approve', 'G2', 'INT-2026-0007', '--scope', 'x']],
  ])('prints the gate usage and exits 2 for %j', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.gate.usage')]);
    expect(h.requests).toEqual([]);
  });
});
