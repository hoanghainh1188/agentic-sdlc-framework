// `sdlc run list|kill` (C11 AC1, D-02 FR-34, ADR-M42 §2.6) against a mocked API, and the parsing of
// the operator command `sdlc ops run kill`. A kill by intent code stops the intent's current run;
// refusals come back with their code; the token never reaches the output.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { parseRunCommand } from '../../apps/cli/src/commands/ops-run.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { killBody, RUN_ID, runListBody } from './fixtures.js';
import { apiError, TOKEN, useHarness } from './harness.js';

const harness = useHarness();
const LIST = '/v1/intents/INT-2026-0007/runs';
const KILL = `/v1/runs/${RUN_ID}/kill`;

describe('sdlc run', () => {
  it('kills a run by its ID', async () => {
    const h = await harness({ routes: { [`POST ${KILL}`]: { status: 202, body: killBody() } } });
    expect(await h.run(['run', 'kill', RUN_ID])).toBe(EXIT.ok);
    expect(h.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([`POST ${KILL}`]);
    expect(h.out).toEqual([
      t('cli.run.killed', {
        run: RUN_ID,
        intent: 'INT-2026-0007',
        status: 'stopping',
        escalation: '66666666-6666-4666-8666-666666666666',
      }),
    ]);
  });

  it('kills the current run of an intent code (the last run that is not final)', async () => {
    const h = await harness({
      routes: {
        [`GET ${LIST}`]: { status: 200, body: runListBody() },
        [`POST ${KILL}`]: { status: 202, body: killBody() },
      },
    });
    expect(await h.run(['run', 'kill', 'int-2026-0007', '--json'])).toBe(EXIT.ok);
    expect(h.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      `GET ${LIST}`,
      `POST ${KILL}`,
    ]);
    expect(JSON.parse(h.out.join('\n'))).toEqual(killBody());
  });

  it('says so when the intent has no run to stop (exit 1, no kill sent)', async () => {
    const h = await harness({
      routes: { [`GET ${LIST}`]: { status: 200, body: runListBody({ status: 'succeeded' }) } },
    });
    expect(await h.run(['run', 'kill', 'INT-2026-0007'])).toBe(EXIT.failed);
    expect(h.out).toEqual([t('cli.run.no_active', { intent: 'INT-2026-0007' })]);
    expect(h.requests).toHaveLength(1);
  });

  it('a second kill reports that nothing changed', async () => {
    const h = await harness({
      routes: { [`POST ${KILL}`]: { status: 202, body: killBody(true) } },
    });
    expect(await h.run(['run', 'kill', RUN_ID])).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      t('cli.run.already_killed', {
        run: RUN_ID,
        intent: 'INT-2026-0007',
        status: 'stopping',
        escalation: '-',
      }),
    );
  });

  it.each([
    [403, 'forbidden'],
    [404, 'run_not_found'],
    [409, 'run_not_active'],
  ])('reports a refusal %i %s (exit 1) without the token', async (status, code) => {
    const h = await harness({ routes: { [`POST ${KILL}`]: apiError(status, code) } });
    expect(await h.run(['run', 'kill', RUN_ID])).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain(code);
    expect([...h.out, ...h.err].join('\n')).not.toContain(TOKEN);
  });

  it('lists the runs, or says there is none', async () => {
    const h = await harness({ routes: { [`GET ${LIST}`]: { status: 200, body: runListBody() } } });
    expect(await h.run(['run', 'list', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(h.out).toHaveLength(2);
    expect(h.out[0]).toContain('stopped_killed');
    expect(h.out[0]).toContain('killed');

    const empty = await harness({
      routes: { [`GET ${LIST}`]: { status: 200, body: runListBody({}, true) } },
    });
    expect(await empty.run(['run', 'list', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(empty.out).toEqual([t('cli.run.none', { intent: 'INT-2026-0007' })]);
  });

  it.each([
    [['run']],
    [['run', 'kill']],
    [['run', 'kill', 'not-a-run']],
    [['run', 'kill', RUN_ID, 'extra']],
    [['run', 'list']],
    [['run', 'stop', RUN_ID]],
  ])('%j prints the usage (exit 2)', async (args) => {
    const h = await harness({ routes: {} });
    expect(await h.run(args)).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain(t('cli.run.usage'));
    expect(h.requests).toHaveLength(0);
  });
});

describe('sdlc ops run kill (parsing)', () => {
  it('needs the tenant and a run ID', () => {
    expect(parseRunCommand(['kill', '--tenant', 'internal', '--run', RUN_ID])).toEqual({
      command: 'kill',
      values: { tenant: 'internal', run: RUN_ID, json: false },
    });
    expect(parseRunCommand(['kill', '--tenant', 'internal'])).toBeUndefined();
    expect(
      parseRunCommand(['kill', '--tenant', 'internal', '--run', 'INT-2026-0001']),
    ).toBeUndefined();
    expect(parseRunCommand(['stop', '--tenant', 'internal', '--run', RUN_ID])).toBeUndefined();
  });
});
