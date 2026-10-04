// `sdlc cost report` over the API (task E04, D-08 E04 AC1, AC2, D-02 FR-53, ADR-M45, handbook
// Ch.19 §19.8c). The whole tenant needs a tenant admin; `--project` or `--intent` needs a role in
// project config `access.cost_read_roles` (never `viewer`). The range is half-open UTC
// [--from, --to); default: the current UTC month. Money is printed as the API sends it (decimal
// strings), never through a JavaScript number. Spend is synced every few minutes and when each run
// ends (C12), so every report ends with the freshness notice (QUESTIONS #197).
import { t, type MessageKey } from '@sdlc/messages';

import { costReportSchema, type CostAmountsView, type CostReportView } from '../api/schemas.js';
import { parseCommand, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { clean, say, show, toJson } from '../output.js';

const GROUPS = new Set(['project', 'intent', 'model', 'status']);

export async function runCost(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'report') return report(rest, ctx);
  return usage(ctx);
}

async function report(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {
    project: { type: 'string' },
    intent: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    by: { type: 'string' },
  });
  if (!parsed) return usage(ctx);
  const { project, intent, from, to, by } = parsed.values as Record<string, string | undefined>;
  if (project !== undefined && intent !== undefined) return usage(ctx);
  if (by !== undefined && !GROUPS.has(by)) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const body = await client.get('/v1/cost/report', costReportSchema, {
      project,
      intent,
      from,
      to,
      by,
    });
    if (json) ctx.stdout(toJson(body));
    else printReport(ctx, body.report);
    return EXIT.ok;
  });
}

const COLUMNS = [
  ['cli.cost.column.calls', (a) => String(a.calls)],
  ['cli.cost.column.input', (a) => a.input_tokens],
  ['cli.cost.column.output', (a) => a.output_tokens],
  ['cli.cost.column.cached', (a) => a.cached_input_tokens],
  ['cli.cost.column.cost', (a) => a.cost_usd],
  ['cli.cost.column.wasted_tokens', (a) => a.wasted_tokens],
  ['cli.cost.column.wasted_cost', (a) => a.wasted_cost_usd],
] as const satisfies readonly (readonly [MessageKey, (a: CostAmountsView) => string])[];

const GROUP_LABEL: Readonly<Record<CostReportView['group_by'], MessageKey>> = {
  project: 'cli.cost.column.project',
  intent: 'cli.cost.column.intent',
  model: 'cli.cost.column.model',
  status: 'cli.cost.column.status',
};

/** The report as a table: one row per group, then the total (exported for tests). */
export function reportTable(report: CostReportView): string[] {
  const header = [t(GROUP_LABEL[report.group_by]), ...COLUMNS.map(([key]) => t(key))];
  const body = report.rows.map((row) => [
    row.key === null ? t('cli.cost.no_key') : clean(row.key),
    ...COLUMNS.map(([, value]) => value(row)),
  ]);
  const total = [t('cli.cost.total'), ...COLUMNS.map(([, value]) => value(report.totals))];
  const lines = [header, ...body, total];
  const widths = header.map((_, i) => Math.max(...lines.map((line) => (line[i] ?? '').length)));
  const render = (line: readonly string[]) =>
    line
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  return [render(header), rule, ...body.map(render), rule, render(total)];
}

function printReport(ctx: CliContext, report: CostReportView): void {
  const scope =
    report.scope.kind === 'tenant'
      ? t('cli.cost.scope.tenant')
      : report.scope.kind === 'project'
        ? t('cli.cost.scope.project', { project: clean(show(report.scope.project)) })
        : t('cli.cost.scope.intent', {
            intent: clean(show(report.scope.intent)),
            project: clean(show(report.scope.project)),
          });
  say(ctx, 'cli.cost.header', { scope, from: report.from, to: report.to });
  if (report.totals.calls === 0) say(ctx, 'cli.cost.empty');
  else for (const line of reportTable(report)) ctx.stdout(line);
  if (report.truncated) say(ctx, 'cli.cost.truncated', { max: report.rows.length });
  say(ctx, 'cli.cost.wasted_note');
  say(ctx, 'cli.cost.freshness', {
    latest_call: show(report.freshness.latest_call_at),
    last_recorded: show(report.freshness.last_recorded_at),
    runs: report.freshness.runs_in_progress,
  });
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.cost.usage'));
  return EXIT.usage;
}
