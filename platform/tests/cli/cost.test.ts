// `sdlc cost report` (E04 AC1, AC2, D-02 FR-53, ADR-M45) against a mocked API: the filters go to
// the API as query parameters, the table shows tokens in and out, cached tokens, cost and wasted
// tokens and cost, money stays the API's decimal string, the freshness notice ends every report,
// refusals come back with their code, and a malformed body is refused.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { reportTable } from '../../apps/cli/src/commands/cost.js';
import { costReportSchema } from '../../apps/cli/src/api/schemas.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { costReportBody } from './fixtures.js';
import { apiError, TOKEN, useHarness } from './harness.js';

const harness = useHarness();
const REPORT = 'GET /v1/cost/report';

describe('sdlc cost report', () => {
  it('sends the scope, range and grouping as query parameters (AC1)', async () => {
    const h = await harness({ routes: { [REPORT]: { status: 200, body: costReportBody() } } });
    const args = ['cost', 'report', '--project', 'pilot', '--from', '2026-10-01'];
    expect(await h.run([...args, '--to', '2026-10-04T00:00:00Z', '--by', 'model'])).toBe(EXIT.ok);
    expect(h.requests).toHaveLength(1);
    const url = h.requests[0]!.url;
    expect(url.pathname).toBe('/v1/cost/report');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      project: 'pilot',
      from: '2026-10-01',
      to: '2026-10-04T00:00:00Z',
      by: 'model',
    });
  });

  it('sends no parameter for the default report (the whole tenant, this month)', async () => {
    const h = await harness({ routes: { [REPORT]: { status: 200, body: costReportBody() } } });
    expect(await h.run(['cost', 'report'])).toBe(EXIT.ok);
    expect([...h.requests[0]!.url.searchParams]).toEqual([]);
  });

  it('prints a table with every amount of AC2, the totals and the freshness notice', async () => {
    const h = await harness({ routes: { [REPORT]: { status: 200, body: costReportBody() } } });
    expect(await h.run(['cost', 'report', '--project', 'pilot'])).toBe(EXIT.ok);
    expect(h.out[0]).toBe(
      t('cli.cost.header', {
        scope: t('cli.cost.scope.project', { project: 'pilot' }),
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-04T00:00:00.000Z',
      }),
    );
    const text = h.out.join('\n');
    for (const label of [
      'cli.cost.column.intent',
      'cli.cost.column.input',
      'cli.cost.column.output',
      'cli.cost.column.cached',
      'cli.cost.column.cost',
      'cli.cost.column.wasted_tokens',
      'cli.cost.column.wasted_cost',
    ] as const) {
      expect(text).toContain(t(label));
    }
    expect(text).toMatch(/INT-2026-0007\s+2\s+1200\s+300\s+100\s+0\.300000\s+500\s+0\.100000/);
    expect(text).toContain(t('cli.cost.no_key'));
    expect(text).toMatch(new RegExp(`${t('cli.cost.total')}\\s+3\\s+1200`));
    expect(h.out.at(-2)).toBe(t('cli.cost.wasted_note'));
    expect(h.out.at(-1)).toBe(
      t('cli.cost.freshness', {
        latest_call: '2026-10-03T10:00:00.000Z',
        last_recorded: '2026-10-03T10:05:00.000Z',
        runs: 1,
      }),
    );
  });

  it('says when nothing is recorded, and still prints the freshness notice', async () => {
    const h = await harness({
      routes: { [REPORT]: { status: 200, body: costReportBody({ empty: true }) } },
    });
    expect(await h.run(['cost', 'report', '--project', 'pilot'])).toBe(EXIT.ok);
    expect(h.out).toContain(t('cli.cost.empty'));
    expect(h.out.at(-1)).toBe(
      t('cli.cost.freshness', { latest_call: '-', last_recorded: '-', runs: 1 }),
    );
  });

  it('says when the rows were cut at the limit', async () => {
    const h = await harness({
      routes: { [REPORT]: { status: 200, body: costReportBody({ truncated: true }) } },
    });
    expect(await h.run(['cost', 'report'])).toBe(EXIT.ok);
    expect(h.out).toContain(t('cli.cost.truncated', { max: 2 }));
  });

  it('--json prints the validated body: money and tokens stay strings', async () => {
    const h = await harness({ routes: { [REPORT]: { status: 200, body: costReportBody() } } });
    expect(await h.run(['cost', 'report', '--intent', 'INT-2026-0007', '--json'])).toBe(EXIT.ok);
    const body = JSON.parse(h.out.join('\n')) as { report: { totals: Record<string, unknown> } };
    expect(body).toEqual(costReportBody());
    expect(body.report.totals['cost_usd']).toBe('0.300000');
    expect(body.report.totals['input_tokens']).toBe('1200');
  });

  it.each([
    [403, 'forbidden'],
    [404, 'project_not_found'],
  ])('reports a refusal %i %s (exit 1) without the token', async (status, code) => {
    const h = await harness({ routes: { [REPORT]: apiError(status, code) } });
    expect(await h.run(['cost', 'report', '--project', 'pilot'])).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain(code);
    expect([...h.out, ...h.err].join('\n')).not.toContain(TOKEN);
  });

  it('a refused range comes back as a usage error (exit 2) naming the issue', async () => {
    const h = await harness({
      routes: {
        [REPORT]: {
          status: 400,
          body: {
            error: {
              code: 'invalid_request',
              message: 'The request is not valid.',
              details: [{ path: 'query.to', issue: 'range_too_long' }],
            },
          },
        },
      },
    });
    expect(await h.run(['cost', 'report', '--from', '2024-01-01'])).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain('range_too_long');
  });

  it('refuses a body with money as a JSON number', async () => {
    const body = costReportBody() as { report: { totals: Record<string, unknown> } };
    body.report.totals['cost_usd'] = 0.3;
    const h = await harness({ routes: { [REPORT]: { status: 200, body } } });
    expect(await h.run(['cost', 'report'])).not.toBe(EXIT.ok);
    expect(h.out).toEqual([]);
  });

  it.each([
    [['cost']],
    [['cost', 'show']],
    [['cost', 'report', '--project', 'pilot', '--intent', 'INT-2026-0007']],
    [['cost', 'report', '--by', 'agent']],
    [['cost', 'report', 'extra']],
    [['cost', 'report', '--tenant', 'internal']],
  ])('%j prints the usage (exit 2)', async (args) => {
    const h = await harness({ routes: {} });
    expect(await h.run(args)).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain(t('cli.cost.usage'));
    expect(h.requests).toHaveLength(0);
  });
});

describe('reportTable', () => {
  it('aligns the columns: the key on the left, numbers on the right', () => {
    const report = costReportSchema.parse(costReportBody()).report;
    const lines = reportTable(report);
    expect(lines).toHaveLength(6); // header, rule, two rows, rule, total
    const widths = new Set(lines.map((line) => line.length));
    expect(widths.size).toBe(1);
  });
});
