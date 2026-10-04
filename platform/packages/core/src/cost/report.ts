// Cost report (task E04, D-02 FR-53, D-07 §5, D-08 E04, design/ADR-M45). Reads `cost_records` as
// synced (ADR-M24 §2.5) for one tenant: the whole tenant, one project or one intent, over a
// half-open UTC range [from, to) on `occurred_at`.
//
// - Who (QUESTIONS #196, ADR-M45 §2.2): the whole tenant needs a tenant admin; a project or an
//   intent needs a tenant admin or a role in project config `access.cost_read_roles` (never
//   `viewer`, rule M28). No role on the project: the project or intent is not found (ADR-M26 §2.5).
// - Wasted (QUESTIONS #195, ADR-M45 §2.3): the records of runs that ended `failed`, `cancelled`
//   or `stopped_*`. Runs still in progress are counted, never wasted.
// - Money stays a decimal string (D-05 D6): summed in SQL `numeric`, formatted with 6 decimals.
//   Token sums are strings of digits.
import type { RunStatus } from '@sdlc/contracts';

import { isTenantAdmin } from '../admin/actor.js';
import { CommandError } from '../commands/errors.js';
import {
  COST_REPORT_GROUPS,
  type CostReportGroup,
  type CostSums,
} from '../db/repositories/cost-records.js';
import type { Project } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { startOfUtcMonth, toMicros } from './money.js';

export { COST_REPORT_GROUPS, type CostReportGroup };

/** Final run statuses whose tokens are wasted (D-07 §5, QUESTIONS #195). */
export const WASTED_RUN_STATUSES = [
  'failed',
  'cancelled',
  'stopped_budget',
  'stopped_scope',
  'stopped_timeout',
  'stopped_stalled',
  'stopped_killed',
] as const satisfies readonly RunStatus[];

/** Runs still in progress: their latest calls may not be synced yet (QUESTIONS #197, C12). */
export const IN_PROGRESS_RUN_STATUSES = [
  'queued',
  'provisioning',
  'running',
  'stopping',
] as const satisfies readonly RunStatus[];

/** Longest range of one report: 366 days (a leap year). */
export const COST_REPORT_MAX_DAYS = 366;
/** Most rows one report shows; more → `truncated`. */
export const COST_REPORT_MAX_ROWS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// RFC 3339 in UTC only: a `Z` suffix, optional fraction. No local times, no offsets.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/**
 * Parses a bound of the range: `YYYY-MM-DD` (00:00 UTC that day) or an RFC 3339 time in UTC
 * (`…Z`). Returns undefined for anything else, including dates that do not exist.
 */
export function parseCostReportTime(value: string): Date | undefined {
  if (!DATE.test(value) && !INSTANT.test(value)) return undefined;
  const at = new Date(DATE.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(at.getTime())) return undefined;
  // `Date` rolls 2026-02-30 over to March: refuse it.
  if (at.toISOString().slice(0, 10) !== value.slice(0, 10)) return undefined;
  return at;
}

export type CostReportRangeIssue = 'range_empty' | 'range_too_long';

export interface CostReportRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * The report's range: `from` inclusive, `to` exclusive. Defaults: the start of the current UTC
 * month (the tenant budget period, ADR-M24 §2.3) to `now`.
 */
export function resolveCostReportRange(
  input: { readonly from?: Date; readonly to?: Date },
  now: Date,
): CostReportRange {
  const to = input.to ?? now;
  const from =
    input.from ?? startOfUtcMonth(input.to === undefined ? now : new Date(to.getTime() - 1));
  return { from, to };
}

/** Why a range is refused, or undefined when it is fine. */
export function checkCostReportRange(range: CostReportRange): CostReportRangeIssue | undefined {
  const span = range.to.getTime() - range.from.getTime();
  if (span <= 0) return 'range_empty';
  if (span > COST_REPORT_MAX_DAYS * DAY_MS) return 'range_too_long';
  return undefined;
}

export interface CostReportInput {
  readonly projectSlug?: string;
  readonly intentCode?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly groupBy?: CostReportGroup;
}

/** Sums of a set of records. Money: decimal strings with 6 decimals; tokens: digit strings. */
export interface CostAmounts {
  readonly calls: number;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cachedInputTokens: string;
  readonly costUsd: string;
  readonly wastedTokens: string;
  readonly wastedCostUsd: string;
}

export interface CostReportRow extends CostAmounts {
  /** Project slug, intent code, model name or run status; null: no intent or no run. */
  readonly key: string | null;
}

export type CostReportScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'project'; readonly project: string }
  | { readonly kind: 'intent'; readonly project: string; readonly intent: string };

export interface CostReport {
  readonly scope: CostReportScope;
  readonly from: Date;
  readonly to: Date;
  readonly groupBy: CostReportGroup;
  readonly totals: CostAmounts;
  readonly rows: readonly CostReportRow[];
  readonly truncated: boolean;
  readonly freshness: {
    readonly latestCallAt: Date | null;
    readonly lastRecordedAt: Date | null;
    readonly runsInProgress: number;
  };
}

/** The default grouping: one level below the scope. */
export function defaultCostReportGroup(scope: CostReportScope['kind']): CostReportGroup {
  if (scope === 'tenant') return 'project';
  if (scope === 'project') return 'intent';
  return 'model';
}

const TOKENS = /^[0-9]+$/;

/** `"0.3"`, `"0.300000"` → `"0.300000"`: a decimal string with exactly 6 decimals. */
export function formatUsd6(value: string): string {
  const micros = toMicros(value);
  if (micros < 0n) throw new RangeError('cost report: negative amount');
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

function tokens(value: string): string {
  // `pg` returns numeric sums as strings; a bigint sum has no fraction.
  if (!TOKENS.test(value)) throw new RangeError('cost report: token sum is not an integer');
  return value.replace(/^0+(?=\d)/, '');
}

/** Turns database sums into report amounts (exported for tests). */
export function toCostAmounts(sums: CostSums): CostAmounts {
  const calls = Number(tokens(sums.calls));
  return {
    calls,
    inputTokens: tokens(sums.input_tokens),
    outputTokens: tokens(sums.output_tokens),
    cachedInputTokens: tokens(sums.cached_input_tokens),
    costUsd: formatUsd6(sums.cost_usd),
    wastedTokens: tokens(sums.wasted_tokens),
    wastedCostUsd: formatUsd6(sums.wasted_cost_usd),
  };
}

interface ResolvedScope {
  readonly scope: CostReportScope;
  readonly projectId?: string;
  readonly intentId?: string;
}

/** Finds the scope and checks that the person may read its cost (QUESTIONS #196). */
async function resolveScope(
  scope: TenantScope,
  userId: string,
  input: CostReportInput,
): Promise<ResolvedScope> {
  const admin = await isTenantAdmin(scope, userId);
  if (input.intentCode !== undefined) {
    const code = input.intentCode;
    const intent = await scope.intents.getByCode(code);
    if (!intent) throw new CommandError('intent_not_found', `intent ${code} not found`);
    const project = await scope.projects.getById(intent.project_id);
    if (!project) throw new CommandError('intent_not_found', `intent ${code} not found`);
    if (!admin) await assertCostReader(scope, project, userId, 'intent_not_found');
    return {
      scope: { kind: 'intent', project: project.slug, intent: intent.code },
      projectId: project.id,
      intentId: intent.id,
    };
  }
  if (input.projectSlug !== undefined) {
    const slug = input.projectSlug;
    const project = await scope.projects.getBySlug(slug);
    if (!project) throw new CommandError('project_not_found', `project ${slug} not found`);
    if (!admin) await assertCostReader(scope, project, userId, 'project_not_found');
    return { scope: { kind: 'project', project: project.slug }, projectId: project.id };
  }
  if (!admin) throw new CommandError('forbidden', 'the whole tenant needs a tenant admin');
  return { scope: { kind: 'tenant' } };
}

/** No role on the project → not found; a role outside `access.cost_read_roles` → forbidden. */
async function assertCostReader(
  scope: TenantScope,
  project: Project,
  userId: string,
  notFound: 'intent_not_found' | 'project_not_found',
): Promise<void> {
  const roles = (await scope.roleBindings.listForUser(userId))
    .filter((binding) => binding.project_id === project.id)
    .map((binding) => binding.role);
  if (roles.length === 0) throw new CommandError(notFound, `${notFound}: no role on the project`);
  const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
  if (!roles.some((role) => config.access.cost_read_roles.includes(role))) {
    throw new CommandError('forbidden', 'no role in access.cost_read_roles');
  }
}

/**
 * Builds the cost report (D-08 E04 AC1, AC2). The caller checks the range first
 * (`checkCostReportRange`); a refused range here is a programming error.
 */
export async function buildCostReport(
  scope: TenantScope,
  actor: { readonly userId: string },
  input: CostReportInput,
  now: Date,
): Promise<CostReport> {
  const range = resolveCostReportRange(input, now);
  if (checkCostReportRange(range) !== undefined) throw new RangeError('cost report: bad range');
  const resolved = await resolveScope(scope, actor.userId, input);
  const groupBy = input.groupBy ?? defaultCostReportGroup(resolved.scope.kind);
  const filter = {
    from: range.from,
    to: range.to,
    ...(resolved.projectId === undefined ? {} : { projectId: resolved.projectId }),
    ...(resolved.intentId === undefined ? {} : { intentId: resolved.intentId }),
    wastedStatuses: WASTED_RUN_STATUSES,
  };
  const where = {
    ...(resolved.projectId === undefined ? {} : { projectId: resolved.projectId }),
    ...(resolved.intentId === undefined ? {} : { intentId: resolved.intentId }),
  };
  const [totals, rows, freshness, runsInProgress] = await Promise.all([
    scope.costRecords.reportTotals(filter),
    scope.costRecords.reportRows({ ...filter, groupBy, limit: COST_REPORT_MAX_ROWS + 1 }),
    scope.costRecords.freshness(where),
    scope.costRecords.countRuns(where, IN_PROGRESS_RUN_STATUSES),
  ]);
  return {
    scope: resolved.scope,
    from: range.from,
    to: range.to,
    groupBy,
    totals: toCostAmounts(totals),
    rows: rows
      .slice(0, COST_REPORT_MAX_ROWS)
      .map((row) => ({ key: row.key, ...toCostAmounts(row) })),
    truncated: rows.length > COST_REPORT_MAX_ROWS,
    freshness: { ...freshness, runsInProgress },
  };
}
