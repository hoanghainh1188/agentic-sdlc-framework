// Step 2 of `sdlc trial report` (task V01, ADR-M65 §2.3): the report, built only from allowed
// fields. Nothing from an API answer is spread or copied whole: each value is picked by name and
// passed through `known` (a list of `@sdlc/contracts`, the stop reasons of D-05, the gateway models),
// a count or an amount.
// Projects become `project-1`, `project-2` … (by slug order) and intents `intent-1` … (oldest
// first); the mapping stays in memory. Times become durations in seconds; only the range keeps
// dates. A new field in an API answer is therefore never in the report.
import {
  ACTOR_TYPES,
  ESCALATION_ROUTES,
  ESCALATION_STATUSES,
  ESCALATION_TRIGGERS,
  GATE_CODES,
  GATE_DECISIONS,
  INTENT_STATUSES,
  RISK_TIERS,
  RUN_STATUSES,
  SEVERITIES,
} from '@sdlc/contracts';

import type { CostAmountsView, GateMetricsView, WaitStatsView } from '../../api/schemas.js';
import type { IntentData, TrialData, TrialRange } from './fetch.js';

export const REPORT_SCHEMA = 'sdlc-trial-report/1';
export const OTHER = 'other';
/** Intent statuses with an end: the lead time is measured for them only. */
const FINISHED = new Set(['done', 'rejected', 'cancelled', 'blocked']);
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The gateway model names of `platform/deploy/litellm/config.ctmpl` (a test keeps them equal). Any
 * other name is `other`: an operator's own model name could name the company (ADR-M65 §2.3).
 */
export const KNOWN_MODELS = ['claude-haiku-4-5-20251001', 'gpt-oss-20b'] as const;

/** The run stop reasons of D-05 §6.4 (`runs.stop_reason`). Any other code is `other`. */
export const KNOWN_STOP_REASONS = [
  'agent_cancelled',
  'agent_changes_unavailable',
  'agent_error',
  'agent_feedback_unavailable',
  'agent_proposal_failed',
  'agent_proposal_unavailable',
  'agent_stuck',
  'agent_task_unavailable',
  'budget_exceeded',
  'contract_expired',
  'key_unavailable',
  'killed',
  'loop_detected',
  'max_budget',
  'max_duration',
  'max_iterations',
  'no_progress',
  'not_decided',
  'prepare_failed',
  'runner_lost',
  'runner_restarted',
  'sandbox_lost',
] as const;

export type Counts = Record<string, number>;

export interface Amounts {
  readonly calls: number;
  readonly input_tokens: string;
  readonly output_tokens: string;
  readonly cached_input_tokens: string;
  readonly cost_usd: string;
  readonly wasted_tokens: string;
  readonly wasted_cost_usd: string;
}

export interface Waits {
  readonly count: number;
  readonly avg_seconds: number | null;
  readonly max_seconds: number | null;
  readonly p50_seconds: number | null;
  readonly p90_seconds: number | null;
}

export interface TrialReport {
  readonly schema: typeof REPORT_SCHEMA;
  readonly platform_version: string;
  readonly generated_on: string;
  readonly range: TrialRange;
  readonly truncated: {
    readonly intents: boolean;
    readonly escalations: boolean;
    readonly gates: boolean;
    readonly cost: boolean;
  };
  readonly totals: Amounts;
  readonly models: readonly (Amounts & { readonly model: string })[];
  readonly projects: readonly ProjectReport[];
}

export interface ProjectReport {
  readonly id: string;
  readonly intents_by_status: Counts;
  readonly gates: readonly {
    readonly gate: string;
    readonly first_round: Waits;
    readonly after_changes: Waits;
    readonly auto_passed: number;
    readonly open: { readonly count: number; readonly oldest_seconds: number | null };
  }[];
  readonly escalations: EscalationCounts;
  readonly intents: readonly IntentReport[];
}

export interface EscalationCounts {
  readonly total: number;
  readonly by_trigger: Counts;
  readonly by_route: Counts;
  readonly by_severity: Counts;
  readonly by_status: Counts;
}

export interface IntentReport {
  readonly id: string;
  readonly risk: string;
  readonly status: string;
  readonly gate: string | null;
  readonly lead_time_seconds: number | null;
  readonly runs: {
    readonly total: number;
    readonly by_status: Counts;
    readonly by_stop_reason: Counts;
  };
  readonly decisions: readonly {
    readonly gate: string;
    readonly decision: string;
    readonly actor: string;
    readonly count: number;
  }[];
  readonly g7_requests_for_changes: number;
  readonly escalations: number;
  readonly cost: Amounts | null;
}

/** A value of a known list, or `other`. */
export function known(list: readonly string[], value: string | null | undefined): string {
  return value !== null && value !== undefined && list.includes(value) ? value : OTHER;
}

/** A run stop reason of D-05, or `other`. */
export function stopReasonOrOther(value: string | null | undefined): string {
  return value !== null && value !== undefined && CODE.test(value)
    ? known(KNOWN_STOP_REASONS, value)
    : OTHER;
}

/** A model name of the platform's gateway configuration, or `other`. */
export function modelOrOther(value: string | null | undefined): string {
  return known(KNOWN_MODELS, value);
}

export function buildReport(
  data: TrialData,
  context: { readonly version: string; readonly today: string; readonly range: TrialRange },
): TrialReport {
  const projectIds = numberProjects(data);
  const intentIds = new Map(data.intents.map((d, index) => [d.intent.code, `intent-${index + 1}`]));
  const costRows = new Map(
    data.costByIntent.rows.flatMap((row) => (row.key === null ? [] : [[row.key, row] as const])),
  );

  const projects = [...new Set(projectIds.values())].map((id) => {
    const slugOf = (slug: string): boolean => projectIds.get(slug) === id;
    const intents = data.intents.filter((d) => slugOf(d.intent.project.slug));
    return {
      id,
      intents_by_status: count(intents, (d) => known(INTENT_STATUSES, d.intent.status)),
      gates: gateRows(data.metrics, slugOf),
      escalations: escalationCounts(intents),
      intents: intents.map((d) =>
        intentReport(d, intentIds.get(d.intent.code) ?? OTHER, costRows.get(d.intent.code)),
      ),
    };
  });

  return {
    schema: REPORT_SCHEMA,
    platform_version: context.version,
    generated_on: context.today,
    range: { from: context.range.from, to: context.range.to },
    truncated: {
      intents: data.truncated.intents,
      escalations: data.truncated.escalations,
      gates: data.metrics.truncated,
      cost: data.costByIntent.truncated || data.costByModel.truncated,
    },
    totals: amounts(data.costByModel.totals),
    models: mergeModels(data.costByModel.rows),
    projects,
  };
}

function numberProjects(data: TrialData): Map<string, string> {
  const slugs = new Set<string>([
    ...data.metrics.rows.map((row) => row.project),
    ...data.intents.map((d) => d.intent.project.slug),
  ]);
  return new Map([...slugs].sort().map((slug, index) => [slug, `project-${index + 1}`]));
}

function gateRows(
  metrics: GateMetricsView,
  ofProject: (slug: string) => boolean,
): ProjectReport['gates'] {
  return metrics.rows
    .filter((row) => ofProject(row.project))
    .map((row) => ({
      gate: known(GATE_CODES, row.gate),
      first_round: waits(row.first_round),
      after_changes: waits(row.after_changes),
      auto_passed: row.auto_passed,
      open: { count: row.open.count, oldest_seconds: row.open.oldest_seconds },
    }));
}

function intentReport(d: IntentData, id: string, cost: CostAmountsView | undefined): IntentReport {
  const decisions = new Map<
    string,
    { gate: string; decision: string; actor: string; count: number }
  >();
  for (const decision of d.detail.decisions) {
    const gate = known(GATE_CODES, decision.gate);
    const kind = known(GATE_DECISIONS, decision.decision);
    const actor = known(ACTOR_TYPES, decision.actor_type);
    const key = `${gate}:${kind}:${actor}`;
    const entry = decisions.get(key) ?? { gate, decision: kind, actor, count: 0 };
    decisions.set(key, { ...entry, count: entry.count + 1 });
  }
  const list = [...decisions.values()].sort((a, b) =>
    `${a.gate}:${a.decision}:${a.actor}`.localeCompare(`${b.gate}:${b.decision}:${b.actor}`),
  );
  const status = known(INTENT_STATUSES, d.intent.status);
  return {
    id,
    risk: known(RISK_TIERS, d.intent.risk_tier),
    status,
    gate: d.intent.current_gate === null ? null : known(GATE_CODES, d.intent.current_gate),
    lead_time_seconds: FINISHED.has(status)
      ? seconds(d.intent.created_at, d.intent.updated_at)
      : null,
    runs: {
      total: d.runs.length,
      by_status: count(d.runs, (run) => known(RUN_STATUSES, run.status)),
      by_stop_reason: count(
        d.runs.filter((run) => run.stop_reason !== null),
        (run) => stopReasonOrOther(run.stop_reason),
      ),
    },
    decisions: list,
    g7_requests_for_changes: list
      .filter((e) => e.gate === 'G7' && e.decision === 'request_changes' && e.actor === 'human')
      .reduce((sum, e) => sum + e.count, 0),
    escalations: d.escalations.length,
    cost: cost === undefined ? null : amounts(cost),
  };
}

function escalationCounts(intents: readonly IntentData[]): EscalationCounts {
  const all = intents.flatMap((d) => d.escalations);
  return {
    total: all.length,
    by_trigger: count(all, (e) => known(ESCALATION_TRIGGERS, e.trigger)),
    by_route: count(all, (e) => known(ESCALATION_ROUTES, e.route)),
    by_severity: count(all, (e) => known(SEVERITIES, e.severity)),
    by_status: count(all, (e) => known(ESCALATION_STATUSES, e.status)),
  };
}

/** One row per model name; names the platform does not configure are summed under `other`. */
function mergeModels(
  rows: readonly (CostAmountsView & { key: string | null })[],
): TrialReport['models'] {
  const merged = new Map<string, Amounts>();
  for (const row of rows) {
    const model = modelOrOther(row.key);
    const before = merged.get(model);
    merged.set(model, before === undefined ? amounts(row) : addAmounts(before, amounts(row)));
  }
  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, value]) => ({ model, ...value }));
}

function amounts(a: CostAmountsView): Amounts {
  return {
    calls: a.calls,
    input_tokens: a.input_tokens,
    output_tokens: a.output_tokens,
    cached_input_tokens: a.cached_input_tokens,
    cost_usd: a.cost_usd,
    wasted_tokens: a.wasted_tokens,
    wasted_cost_usd: a.wasted_cost_usd,
  };
}

/** Sums of digit strings and 6-decimal strings, with BigInt: never a float (D-05 D6). */
function addAmounts(a: Amounts, b: Amounts): Amounts {
  const int = (x: string, y: string): string => (BigInt(x) + BigInt(y)).toString();
  const usd = (x: string, y: string): string => {
    const micro = BigInt(x.replace('.', '')) + BigInt(y.replace('.', ''));
    const text = micro.toString().padStart(7, '0');
    return `${text.slice(0, -6)}.${text.slice(-6)}`;
  };
  return {
    calls: a.calls + b.calls,
    input_tokens: int(a.input_tokens, b.input_tokens),
    output_tokens: int(a.output_tokens, b.output_tokens),
    cached_input_tokens: int(a.cached_input_tokens, b.cached_input_tokens),
    cost_usd: usd(a.cost_usd, b.cost_usd),
    wasted_tokens: int(a.wasted_tokens, b.wasted_tokens),
    wasted_cost_usd: usd(a.wasted_cost_usd, b.wasted_cost_usd),
  };
}

function waits(stats: WaitStatsView): Waits {
  return {
    count: stats.count,
    avg_seconds: stats.avg_seconds,
    max_seconds: stats.max_seconds,
    p50_seconds: stats.p50_seconds,
    p90_seconds: stats.p90_seconds,
  };
}

function seconds(from: string, to: string): number | null {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 1000) : null;
}

function count<T>(items: readonly T[], key: (item: T) => string): Counts {
  const counts: Counts = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
