// `sdlc trial report` (task V01, D-08 V01 AC3, ADR-M65, handbook Ch.19 §19.8c): the report a
// community trial team sends as a GitHub issue (TRIAL.md §6). It reads the existing GET endpoints
// only (no new endpoint, the same access rules: the whole tenant needs a tenant admin; `--project`
// needs a role in `access.metrics_read_roles` and `access.cost_read_roles`), then builds an
// anonymous report: counts, codes, durations, amounts and model names only (ADR-M65 §2.3). Three
// steps: fetch (`trial/fetch.ts`), build (`trial/build.ts`), check (`trial/check.ts`, fail closed).
import { t, type MessageKey } from '@sdlc/messages';

import { ApiCallError, ApiClient } from '../api/client.js';
import { exitCodeOf } from '../api/errors.js';
import { apiIo, assertTlsVerified, guarded, parseCommand, resolveLogin } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, sayError, toJson } from '../output.js';
import { PLATFORM_VERSION } from '../version.js';
import { formatDuration } from './metrics.js';
import { buildReport, type ProjectReport, type TrialReport } from './trial/build.js';
import { reportIsSafe } from './trial/check.js';
import {
  DEFAULT_MAX_INTENTS,
  fetchTrialData,
  MAX_MAX_INTENTS,
  RETRIES,
  retryable,
  type TrialRange,
} from './trial/fetch.js';

/** Each API call of the report may take this long (the CLI's default is 30 s). */
export const TRIAL_TIMEOUT_MS = 15_000;
export const DEFAULT_RANGE_DAYS = 90;
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export interface TrialHooks {
  /** The clock (tests pass a fixed one). */
  readonly now?: () => Date;
  /** Waits between tries (tests pass a fast one). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function runTrial(
  args: readonly string[],
  ctx: CliContext,
  hooks: TrialHooks = {},
): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'report') return report(rest, ctx, hooks);
  return usage(ctx);
}

async function report(
  args: readonly string[],
  ctx: CliContext,
  hooks: TrialHooks,
): Promise<number> {
  const parsed = parseCommand(args, {
    project: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    'max-intents': { type: 'string' },
  });
  if (!parsed) return usage(ctx);
  const values = parsed.values as Record<string, string | undefined>;
  const now = (hooks.now ?? (() => new Date()))();
  const range = trialRange(values.from, values.to, now);
  const maxIntents = maxIntentsOf(values['max-intents']);
  if (!range || maxIntents === undefined) return usage(ctx);
  const json = parsed.values.json === true;

  return guarded(ctx, json, async () => {
    assertTlsVerified(ctx);
    const login = await resolveLogin(ctx);
    const client = new ApiClient({
      apiUrl: login.apiUrl,
      token: login.token,
      fetch: apiIo(ctx).fetch,
      timeoutMs: TRIAL_TIMEOUT_MS,
    });
    let data;
    try {
      data = await fetchTrialData(client, {
        ...(values.project === undefined ? {} : { project: values.project }),
        range,
        maxIntents,
        ...(hooks.sleep ? { sleep: hooks.sleep } : {}),
      });
    } catch (error) {
      if (!(error instanceof ApiCallError)) throw error;
      // Only fixed texts: an API message can name an intent or a project, and a team may paste
      // this output into a public issue (ADR-M65 §2.4).
      const status = error.status ?? 0;
      if (retryable(error)) sayError(ctx, 'cli.trial.fetch_failed', { tries: RETRIES + 1, status });
      else sayError(ctx, 'cli.trial.fetch_refused', { status, kind: error.kind });
      if (json)
        ctx.stderr(toJson({ error: { code: 'trial_no_report', kind: error.kind, status } }));
      return exitCodeOf(error);
    }
    const built = buildReport(data, {
      version: PLATFORM_VERSION,
      today: now.toISOString().slice(0, 10),
      range,
    });
    if (!reportIsSafe(built)) {
      sayError(ctx, 'cli.trial.check_failed');
      return EXIT.error;
    }
    if (json) ctx.stdout(toJson(built));
    else printReport(ctx, built);
    return EXIT.ok;
  });
}

/**
 * The range as two UTC dates, `from` included and `to` excluded. Default: the 90 days that end
 * with today. Undefined: a bad date, `from` not before `to`, or more than 366 days.
 */
export function trialRange(
  from: string | undefined,
  to: string | undefined,
  now: Date,
): TrialRange | undefined {
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const end = to === undefined ? tomorrow : parseDay(to);
  if (!end) return undefined;
  const start =
    from === undefined ? new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS) : parseDay(from);
  if (!start) return undefined;
  const days = (end.getTime() - start.getTime()) / DAY_MS;
  if (days <= 0 || days > MAX_RANGE_DAYS) return undefined;
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function parseDay(value: string): Date | undefined {
  if (!DATE.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? undefined
    : date;
}

function maxIntentsOf(value: string | undefined): number | undefined {
  if (value === undefined) return DEFAULT_MAX_INTENTS;
  if (!/^[0-9]{1,4}$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= MAX_MAX_INTENTS ? parsed : undefined;
}

function printReport(ctx: CliContext, r: TrialReport): void {
  say(ctx, 'cli.trial.header', { version: r.platform_version, from: r.range.from, to: r.range.to });
  if (r.projects.every((p) => p.intents.length === 0)) say(ctx, 'cli.trial.empty');
  for (const project of r.projects) printProject(ctx, project);
  for (const m of r.models) {
    say(ctx, 'cli.trial.model', {
      model: m.model,
      calls: m.calls,
      input: m.input_tokens,
      output: m.output_tokens,
      cost: m.cost_usd,
      wasted: m.wasted_cost_usd,
    });
  }
  say(ctx, 'cli.trial.total', {
    calls: r.totals.calls,
    cost: r.totals.cost_usd,
    wasted: r.totals.wasted_cost_usd,
  });
  const cut = Object.entries(r.truncated)
    .filter(([, value]) => value)
    .map(([key]) => key);
  if (cut.length > 0) say(ctx, 'cli.trial.truncated', { parts: cut.join(', ') });
  say(ctx, 'cli.trial.send');
}

function printProject(ctx: CliContext, p: ProjectReport): void {
  const statuses = Object.entries(p.intents_by_status)
    .map(([status, count]) => `${status} ${String(count)}`)
    .join(', ');
  say(ctx, 'cli.trial.project', {
    project: p.id,
    intents: p.intents.length,
    statuses: statuses === '' ? '-' : statuses,
    escalations: p.escalations.total,
  });
  for (const g of p.gates) {
    say(ctx, 'cli.trial.gate', {
      gate: g.gate,
      first: formatDuration(g.first_round.avg_seconds),
      first_count: g.first_round.count,
      after: formatDuration(g.after_changes.avg_seconds),
      after_count: g.after_changes.count,
      auto: g.auto_passed,
      open: g.open.count,
    });
  }
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.trial.usage' satisfies MessageKey));
  return EXIT.usage;
}
