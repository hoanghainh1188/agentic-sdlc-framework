// Gate waiting-time metrics (task E06, D-02 FR-12 and §14, D-08 E06 AC1, design/ADR-M47). For one
// tenant: the whole tenant or one project, one row per (project, gate).
//
// - Finished waits (QUESTIONS #205): people's decisions with `waited_seconds`, the wall-clock time
//   since the intent entered the gate (FR-12, B07 session 2). Split into the first round (no
//   request for changes earlier in the same visit: the time a person was waited for) and after
//   changes (includes the producer's rework). Count, average, maximum, median and p90 of each.
// - `autoPassed`: the platform's HOTL and AUDIT passes at G1–G3, G7, G8; never in the statistics.
// - `open` (QUESTIONS #207): intents at the gate now, every gate, with the oldest wait; never in the
//   statistics, and not bound to the range or the mode.
// - Who (QUESTIONS #206): the whole tenant needs a tenant admin; a project needs a tenant admin or a
//   role in project config `access.metrics_read_roles` (never `viewer`, rule M29). No role on the
//   project: the project is not found (ADR-M26 §2.5). Never a breakdown per person.
import { GATE_CODES, type GateCheckMode, type GateCode, type RiskTier } from '@sdlc/contracts';

import { isTenantAdmin } from '../admin/actor.js';
import { CommandError } from '../commands/errors.js';
import { checkCostReportRange, type CostReportRangeIssue } from '../cost/report.js';
import type { WaitStatsRow } from '../db/repositories/gate-metrics.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';

/** Default range: the last 30 days (QUESTIONS #205). */
export const GATE_METRICS_DEFAULT_DAYS = 30;
/** Most rows one report shows; more → `truncated`. */
export const GATE_METRICS_MAX_ROWS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GateMetricsRange {
  readonly from: Date;
  readonly to: Date;
}

/**
 * The range of the decisions: `from` inclusive, `to` exclusive (UTC). Defaults: the 30 days before
 * `to`, and `to` = `now`.
 */
export function resolveGateMetricsRange(
  input: { readonly from?: Date; readonly to?: Date },
  now: Date,
): GateMetricsRange {
  const to = input.to ?? now;
  const from = input.from ?? new Date(to.getTime() - GATE_METRICS_DEFAULT_DAYS * DAY_MS);
  return { from, to };
}

/** Why a range is refused (empty, longer than 366 days), or undefined. Same rules as E04. */
export function checkGateMetricsRange(range: GateMetricsRange): CostReportRangeIssue | undefined {
  return checkCostReportRange(range);
}

export interface GateMetricsInput {
  readonly projectSlug?: string;
  readonly gate?: GateCode;
  readonly mode?: GateCheckMode;
  readonly riskTier?: RiskTier;
  readonly from?: Date;
  readonly to?: Date;
}

/** Statistics of a group of finished waits, in whole seconds; null values when `count` is 0. */
export interface WaitStats {
  readonly count: number;
  readonly avgSeconds: number | null;
  readonly maxSeconds: number | null;
  readonly p50Seconds: number | null;
  readonly p90Seconds: number | null;
}

export interface GateMetricsRow {
  readonly project: string;
  readonly gate: GateCode;
  readonly firstRound: WaitStats;
  readonly afterChanges: WaitStats;
  readonly autoPassed: number;
  readonly open: { readonly count: number; readonly oldestSeconds: number | null };
}

export type GateMetricsScope =
  { readonly kind: 'tenant' } | { readonly kind: 'project'; readonly project: string };

export interface GateMetrics {
  readonly scope: GateMetricsScope;
  readonly from: Date;
  readonly to: Date;
  /** When the open waits were measured. */
  readonly asOf: Date;
  readonly filters: {
    readonly gate: GateCode | null;
    readonly mode: GateCheckMode | null;
    readonly riskTier: RiskTier | null;
  };
  readonly rows: readonly GateMetricsRow[];
  readonly truncated: boolean;
}

const NO_WAITS: WaitStats = {
  count: 0,
  avgSeconds: null,
  maxSeconds: null,
  p50Seconds: null,
  p90Seconds: null,
};

function stats(row: WaitStatsRow | undefined): WaitStats {
  if (!row) return NO_WAITS;
  return {
    count: row.count,
    avgSeconds: row.avgSeconds,
    maxSeconds: row.maxSeconds,
    p50Seconds: row.p50Seconds,
    p90Seconds: row.p90Seconds,
  };
}

const key = (project: string, gate: GateCode) => `${project}\u0000${gate}`;

/**
 * Merges the three groupings into one row per (project, gate), sorted by project then gate
 * (exported for tests). Rows with nothing to show are never made: every key comes from a query row.
 */
export function mergeGateMetrics(
  parts: {
    readonly waits: readonly WaitStatsRow[];
    readonly autoPasses: readonly { project: string; gate: GateCode; count: number }[];
    readonly open: readonly {
      project: string;
      gate: GateCode;
      count: number;
      oldestEnteredAt: Date;
    }[];
  },
  now: Date,
): GateMetricsRow[] {
  const keys = new Map<string, { project: string; gate: GateCode }>();
  for (const part of [parts.waits, parts.autoPasses, parts.open]) {
    for (const row of part) keys.set(key(row.project, row.gate), row);
  }
  const rows = [...keys.values()].map(({ project, gate }) => {
    const k = key(project, gate);
    const waits = parts.waits.filter((w) => key(w.project, w.gate) === k);
    const open = parts.open.find((o) => key(o.project, o.gate) === k);
    return {
      project,
      gate,
      firstRound: stats(waits.find((w) => !w.afterChanges)),
      afterChanges: stats(waits.find((w) => w.afterChanges)),
      autoPassed: parts.autoPasses.find((a) => key(a.project, a.gate) === k)?.count ?? 0,
      open: open
        ? {
            count: open.count,
            oldestSeconds: Math.max(
              0,
              Math.floor((now.getTime() - open.oldestEnteredAt.getTime()) / 1000),
            ),
          }
        : { count: 0, oldestSeconds: null },
    };
  });
  return rows.sort(
    (a, b) =>
      (a.project < b.project ? -1 : a.project > b.project ? 1 : 0) ||
      GATE_CODES.indexOf(a.gate) - GATE_CODES.indexOf(b.gate),
  );
}

/** Finds the scope and checks that the person may read its metrics (QUESTIONS #206). */
async function resolveScope(
  scope: TenantScope,
  userId: string,
  projectSlug: string | undefined,
): Promise<{ scope: GateMetricsScope; projectId?: string }> {
  const admin = await isTenantAdmin(scope, userId);
  if (projectSlug === undefined) {
    if (!admin) throw new CommandError('forbidden', 'the whole tenant needs a tenant admin');
    return { scope: { kind: 'tenant' } };
  }
  const project = await scope.projects.getBySlug(projectSlug);
  if (!project) throw new CommandError('project_not_found', `project ${projectSlug} not found`);
  if (!admin) {
    const roles = (await scope.roleBindings.listForUser(userId))
      .filter((binding) => binding.project_id === project.id)
      .map((binding) => binding.role);
    if (roles.length === 0) {
      throw new CommandError('project_not_found', 'project_not_found: no role on the project');
    }
    const { config } = await loadEffectiveConfig(scope.projectConfigs, project.id);
    if (!roles.some((role) => config.access.metrics_read_roles.includes(role))) {
      throw new CommandError('forbidden', 'no role in access.metrics_read_roles');
    }
  }
  return { scope: { kind: 'project', project: project.slug }, projectId: project.id };
}

/**
 * Builds the gate waiting-time metrics (D-08 E06 AC1). The caller checks the range first
 * (`checkGateMetricsRange`); a refused range here is a programming error.
 */
export async function buildGateMetrics(
  scope: TenantScope,
  actor: { readonly userId: string },
  input: GateMetricsInput,
  now: Date,
): Promise<GateMetrics> {
  const range = resolveGateMetricsRange(input, now);
  if (checkGateMetricsRange(range) !== undefined) throw new RangeError('gate metrics: bad range');
  const resolved = await resolveScope(scope, actor.userId, input.projectSlug);
  const filter = {
    ...(resolved.projectId === undefined ? {} : { projectId: resolved.projectId }),
    ...(input.gate === undefined ? {} : { gate: input.gate }),
    ...(input.riskTier === undefined ? {} : { riskTier: input.riskTier }),
  };
  const decisions = {
    ...filter,
    from: range.from,
    to: range.to,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
  };
  const [waits, autoPasses, open] = await Promise.all([
    scope.gateMetrics.waitStats(decisions),
    scope.gateMetrics.autoPasses(decisions),
    scope.gateMetrics.openWaits(filter),
  ]);
  const rows = mergeGateMetrics({ waits, autoPasses, open }, now);
  return {
    scope: resolved.scope,
    from: range.from,
    to: range.to,
    asOf: now,
    filters: {
      gate: input.gate ?? null,
      mode: input.mode ?? null,
      riskTier: input.riskTier ?? null,
    },
    rows: rows.slice(0, GATE_METRICS_MAX_ROWS),
    truncated: rows.length > GATE_METRICS_MAX_ROWS,
  };
}
