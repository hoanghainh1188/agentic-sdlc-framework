// The evaluation report (task L02, design/ADR-M78 §2.5, AC3, AC4, AC10). Built from the run
// results only (numbers and codes), so it can never hold a prompt, task text, code or a diff.
// - Per configuration: resolve rate with a bootstrap interval over tasks, pass@1, pass@k and
//   pass^k (k = the fewest runs of any task), CI on the first try, scope breaches, stops, time,
//   tokens, cost, cost per resolved run.
// - Per pair of configurations: McNemar's exact test on runs paired by (task, run number). A
//   difference is called only when the intervals do not overlap and p < 0.05.
// - The Bradley-Terry ranking of blind pairwise choices, when there are any.
// Labels come from the message catalog (`eval.report.*`).
import { t } from '@sdlc/messages';

import { hardwareLabel, type ExecutionPlace, type HardwareInfo } from './hardware.js';
import type { RunResult } from './result.js';
import {
  bootstrapMean,
  bradleyTerry,
  mcnemarExact,
  passAtK,
  passHatK,
  type Interval,
  type PairChoice,
} from './stats.js';

export interface ConfigurationSummary {
  readonly configuration: string;
  readonly model: string;
  readonly tasks: number;
  readonly runs: number;
  /** The k of pass@k and pass^k: the fewest runs of any task of this configuration. */
  readonly k: number;
  readonly resolved: Interval;
  readonly passAt1: number;
  readonly passAtK: number;
  readonly passHatK: number;
  readonly ciFirstTry: number;
  readonly scopeBreaches: number;
  /** Runs that ended at a cap or stalled (`stopped_*`), or failed. */
  readonly stopped: number;
  readonly medianSeconds: number;
  readonly meanInputTokens: number;
  readonly meanOutputTokens: number;
  readonly totalCostUsd: string;
  /** Total cost divided by resolved runs; null when none resolved. */
  readonly costPerResolvedUsd: string | null;
}

export interface TaskRow {
  readonly task: string;
  readonly configuration: string;
  readonly runs: number;
  readonly resolved: number;
}

export interface Comparison {
  readonly a: string;
  readonly b: string;
  /** Paired runs (same task and run number in both). */
  readonly pairs: number;
  readonly onlyA: number;
  readonly onlyB: number;
  readonly pValue: number;
  /** `a`, `b`, or null when the data does not show a difference. */
  readonly better: string | null;
}

export interface Environment {
  readonly where: ExecutionPlace | null;
  readonly hardware: HardwareInfo | null;
  readonly runs: number;
}

export interface EvalReport {
  readonly taskSet: number;
  readonly configurations: readonly ConfigurationSummary[];
  readonly tasks: readonly TaskRow[];
  readonly comparisons: readonly Comparison[];
  /** Bradley-Terry strengths, highest first; empty without pairwise choices. */
  /** Where the runs happened and on what hardware; results of L02 have no such block. */
  readonly environments: readonly Environment[];
  readonly ranking: readonly { readonly configuration: string; readonly strength: number }[];
  readonly pairChoices: number;
}

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

function micros(usd: string): bigint {
  const [whole = '0', fraction = ''] = usd.split('.');
  return BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
}

function usd(value: bigint): string {
  return `${String(value / 1_000_000n)}.${String(value % 1_000_000n).padStart(6, '0')}`;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function byTask(results: readonly RunResult[]): Map<string, RunResult[]> {
  const map = new Map<string, RunResult[]>();
  for (const r of results) map.set(r.task, [...(map.get(r.task) ?? []), r]);
  return map;
}

function summarise(
  configuration: string,
  results: readonly RunResult[],
  seed: number,
): ConfigurationSummary {
  const tasks = byTask(results);
  const counts = [...tasks.values()].map((runs) => ({
    n: runs.length,
    c: runs.filter((r) => r.resolved).length,
  }));
  const k = Math.min(...counts.map((x) => x.n));
  const perTask = (estimate: (n: number, c: number) => number) =>
    counts.reduce((sum, { n, c }) => sum + estimate(n, c), 0) / counts.length;
  const total = results.reduce((sum, r) => sum + micros(r.cost_usd), 0n);
  const resolvedRuns = results.filter((r) => r.resolved).length;
  return {
    configuration,
    model: results[0]!.model,
    tasks: tasks.size,
    runs: results.length,
    k,
    resolved: bootstrapMean(
      counts.map(({ n, c }) => c / n),
      { seed },
    ),
    passAt1: round(perTask((n, c) => passAtK(n, c, 1))),
    passAtK: round(perTask((n, c) => passAtK(n, c, k))),
    passHatK: round(perTask((n, c) => passHatK(n, c, k))),
    ciFirstTry: round(results.filter((r) => r.ci_passed).length / results.length),
    scopeBreaches: results.filter((r) => r.scope_breach).length,
    stopped: results.filter((r) => r.status === 'failed' || r.status.startsWith('stopped_')).length,
    medianSeconds: median(results.map((r) => r.seconds)),
    meanInputTokens: Math.round(results.reduce((s, r) => s + r.input_tokens, 0) / results.length),
    meanOutputTokens: Math.round(results.reduce((s, r) => s + r.output_tokens, 0) / results.length),
    totalCostUsd: usd(total),
    costPerResolvedUsd: resolvedRuns === 0 ? null : usd(total / BigInt(resolvedRuns)),
  };
}

function compare(
  a: ConfigurationSummary,
  b: ConfigurationSummary,
  results: readonly RunResult[],
): Comparison {
  const key = (r: RunResult) => `${r.task}\u0000${String(r.run)}`;
  const ofB = new Map(
    results.filter((r) => r.configuration === b.configuration).map((r) => [key(r), r]),
  );
  let pairs = 0;
  let onlyA = 0;
  let onlyB = 0;
  for (const ra of results.filter((r) => r.configuration === a.configuration)) {
    const rb = ofB.get(key(ra));
    if (!rb) continue;
    pairs += 1;
    if (ra.resolved && !rb.resolved) onlyA += 1;
    if (rb.resolved && !ra.resolved) onlyB += 1;
  }
  const pValue = mcnemarExact(onlyA, onlyB);
  const apart = a.resolved.low > b.resolved.high || b.resolved.low > a.resolved.high;
  const better =
    apart && pValue < 0.05
      ? a.resolved.estimate > b.resolved.estimate
        ? a.configuration
        : b.configuration
      : null;
  return {
    a: a.configuration,
    b: b.configuration,
    pairs,
    onlyA,
    onlyB,
    pValue: round(pValue, 4),
    better,
  };
}

/** The distinct places and machines behind the results, with their run counts. */
function environmentsOf(results: readonly RunResult[]): Environment[] {
  const groups = new Map<string, Environment>();
  for (const r of results) {
    const hardware = r.hardware ?? null;
    const where = r.where ?? null;
    const key = JSON.stringify([where, hardware]);
    groups.set(key, { where, hardware, runs: (groups.get(key)?.runs ?? 0) + 1 });
  }
  return [...groups.values()].sort((x, y) => y.runs - x.runs);
}

/** Builds the report of one task set version (`seed` makes the bootstrap repeatable). */
export function buildReport(
  results: readonly RunResult[],
  taskSet: number,
  choices: readonly PairChoice[] = [],
  seed = 1,
): EvalReport {
  const ofSet = results.filter((r) => r.task_set === taskSet);
  const ids = [...new Set(ofSet.map((r) => r.configuration))].sort();
  const configurations = ids.map((id) =>
    summarise(
      id,
      ofSet.filter((r) => r.configuration === id),
      seed,
    ),
  );
  const tasks: TaskRow[] = [];
  for (const id of ids) {
    for (const [task, runs] of [...byTask(ofSet.filter((r) => r.configuration === id))].sort()) {
      tasks.push({
        task,
        configuration: id,
        runs: runs.length,
        resolved: runs.filter((r) => r.resolved).length,
      });
    }
  }
  const comparisons: Comparison[] = [];
  for (let i = 0; i < configurations.length; i++) {
    for (let j = i + 1; j < configurations.length; j++) {
      comparisons.push(compare(configurations[i]!, configurations[j]!, ofSet));
    }
  }
  const ranking = [...bradleyTerry(choices)]
    .map(([configuration, strength]) => ({ configuration, strength: round(strength) }))
    .sort((x, y) => y.strength - x.strength || x.configuration.localeCompare(y.configuration));
  return {
    taskSet,
    configurations,
    tasks,
    comparisons,
    environments: environmentsOf(ofSet),
    ranking,
    pairChoices: choices.length,
  };
}

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

/** The report as Markdown, labels from the catalog. */
export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [
    `# ${t('eval.report.title', { version: report.taskSet })}`,
    '',
    t('eval.report.note'),
    '',
    `| ${[
      t('eval.report.column.configuration'),
      t('eval.report.column.model'),
      t('eval.report.column.runs'),
      t('eval.report.column.resolved'),
      t('eval.report.column.pass_at_k'),
      t('eval.report.column.pass_hat_k'),
      t('eval.report.column.ci_first'),
      t('eval.report.column.breaches'),
      t('eval.report.column.stopped'),
      t('eval.report.column.median_seconds'),
      t('eval.report.column.cost'),
      t('eval.report.column.cost_resolved'),
    ].join(' | ')} |`,
    `|${' --- |'.repeat(12)}`,
  ];
  for (const c of report.configurations) {
    lines.push(
      `| ${[
        c.configuration,
        c.model,
        String(c.runs),
        `${percent(c.resolved.estimate)} (${percent(c.resolved.low)}–${percent(c.resolved.high)})`,
        `${percent(c.passAtK)} (k=${String(c.k)})`,
        percent(c.passHatK),
        percent(c.ciFirstTry),
        String(c.scopeBreaches),
        String(c.stopped),
        String(c.medianSeconds),
        c.totalCostUsd,
        c.costPerResolvedUsd ?? '-',
      ].join(' | ')} |`,
    );
  }
  if (report.comparisons.length > 0) {
    lines.push('', `## ${t('eval.report.comparisons')}`, '');
    for (const c of report.comparisons) {
      lines.push(
        `- ${t(c.better === null ? 'eval.report.no_difference' : 'eval.report.difference', {
          a: c.a,
          b: c.b,
          better: c.better ?? '',
          pairs: c.pairs,
          only_a: c.onlyA,
          only_b: c.onlyB,
          p: c.pValue,
        })}`,
      );
    }
  }
  lines.push('', `## ${t('eval.report.per_task')}`, '');
  lines.push(
    `| ${t('eval.report.column.task')} | ${t('eval.report.column.configuration')} | ${t('eval.report.column.resolved')} |`,
  );
  lines.push('| --- | --- | --- |');
  for (const row of report.tasks) {
    lines.push(
      `| ${row.task} | ${row.configuration} | ${String(row.resolved)} / ${String(row.runs)} |`,
    );
  }
  lines.push('', `## ${t('eval.report.where')}`, '');
  for (const e of report.environments) {
    lines.push(
      e.where === null || e.hardware === null
        ? `- ${t('eval.report.where_unknown', { runs: e.runs })}`
        : `- ${t('eval.report.where_line', {
            where:
              e.where === 'server'
                ? t('eval.report.place.server')
                : t('eval.report.place.developer'),
            hardware: hardwareLabel(e.hardware),
            docker: e.hardware.docker_version,
            gpu: e.hardware.gpu ?? t('eval.report.no_gpu'),
            runner: e.hardware.runner_instance ?? '-',
            runs: e.runs,
          })}`,
    );
  }
  lines.push('', `## ${t('eval.report.ranking')}`, '');
  if (report.ranking.length === 0) lines.push(t('eval.report.no_pairs'));
  else {
    lines.push(t('eval.report.ranking_note', { choices: report.pairChoices }), '');
    for (const r of report.ranking) lines.push(`- ${r.configuration}: ${r.strength.toFixed(3)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** A quality-against-cost (Pareto) chart: one point per configuration, resolve rate by cost. */
export function renderParetoSvg(report: EvalReport): string {
  const width = 640;
  const height = 400;
  const pad = 56;
  const costs = report.configurations.map((c) => Number(c.totalCostUsd) / Math.max(1, c.runs));
  const maxCost = Math.max(...costs, 0.000001);
  const x = (cost: number) => pad + (cost / maxCost) * (width - 2 * pad);
  const y = (rate: number) => height - pad - rate * (height - 2 * pad);
  const points = report.configurations
    .map((c, i) => {
      const cx = x(costs[i]!).toFixed(1);
      return [
        `<line x1="${cx}" x2="${cx}" y1="${y(c.resolved.low).toFixed(1)}" y2="${y(c.resolved.high).toFixed(1)}" stroke="#4b5563"/>`,
        `<circle cx="${cx}" cy="${y(c.resolved.estimate).toFixed(1)}" r="5" fill="#2563eb"/>`,
        `<text x="${(Number(cx) + 8).toFixed(1)}" y="${(y(c.resolved.estimate) - 8).toFixed(1)}" font-size="12">${escapeXml(c.configuration)}</text>`,
      ].join('');
    })
    .join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" font-family="sans-serif">`,
    `<title>${escapeXml(t('eval.report.chart_title', { version: report.taskSet }))}</title>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<line x1="${String(pad)}" y1="${String(height - pad)}" x2="${String(width - pad)}" y2="${String(height - pad)}" stroke="#111827"/>`,
    `<line x1="${String(pad)}" y1="${String(pad)}" x2="${String(pad)}" y2="${String(height - pad)}" stroke="#111827"/>`,
    `<text x="${String(width / 2)}" y="${String(height - 16)}" text-anchor="middle" font-size="12">${escapeXml(t('eval.report.chart_x'))}</text>`,
    `<text x="16" y="${String(height / 2)}" text-anchor="middle" font-size="12" transform="rotate(-90 16 ${String(height / 2)})">${escapeXml(t('eval.report.chart_y'))}</text>`,
    points,
    '</svg>',
    '',
  ].join('\n');
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}
