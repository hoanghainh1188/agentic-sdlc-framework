// `sdlc eval …`: evaluation plans and evaluations over the API (task L05, design/ADR-M82 §2.7).
// - `sdlc eval plan list --project <slug>` and `sdlc eval plan show <plan-id>`;
// - `sdlc eval plan create --project <slug> --file <plan.json>` and
//   `sdlc eval plan change <plan-id> --file <plan.json> --expected-version <n>`: the file holds the
//   plan's fields as the API takes them (codes, numbers, amounts, a prompt variant's path; never a
//   prompt text), at most 64 KB;
// - `sdlc eval plan archive <plan-id>`; `sdlc eval run <plan-id>` (Run now: the worker starts it);
// - `sdlc eval list --project <slug> | --plan <plan-id>` and `sdlc eval show <EVAL-…>`;
// - `sdlc eval report <EVAL-…>` (task L06, ADR-M83): the report with its recommendations by rules
//   and the real-run numbers of V13 for the same models; every text from the catalog.
// A role in the project's `access.eval_roles` changes and runs plans; a role on the project reads.
import fs from 'node:fs';

import { recommendationKey } from '@sdlc/eval';
import { t } from '@sdlc/messages';

import {
  evalPlanListSchema,
  evalPlanSchema,
  evaluationListSchema,
  evaluationReportSchema,
  evaluationSchema,
  type EvaluationReportView,
  type EvalPlanSummaryView,
  type EvaluationView,
} from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, show, toJson } from '../output.js';
import { runEvalTask } from './eval-task.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVAL_CODE = /^EVAL-[0-9]{4}-[0-9]{4,9}$/;
const MAX_FILE_BYTES = 64 * 1024;

export async function runEval(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'plan') return runPlan(rest, ctx);
  if (command === 'run') return runRun(rest, ctx);
  if (command === 'list') return runList(rest, ctx);
  if (command === 'show') return runShow(rest, ctx);
  if (command === 'report') return runReport(rest, ctx);
  if (command === 'task') return runEvalTask(rest, ctx);
  return usage(ctx);
}

async function runPlan(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case 'list': {
      const parsed = parseCommand(rest, { project: { type: 'string' } });
      const project = parsed?.values.project;
      if (typeof project !== 'string' || !SLUG.test(project)) return usage(ctx);
      const json = parsed?.values.json === true;
      return withApi(ctx, json, async (client) => {
        const list = await client.get(
          `/v1/projects/${segment(project)}/eval-plans`,
          evalPlanListSchema,
        );
        if (json) ctx.stdout(toJson(list));
        else if (list.plans.length === 0) say(ctx, 'cli.eval.plan.none', { project });
        else for (const plan of list.plans) printPlan(ctx, plan);
        return EXIT.ok;
      });
    }
    case 'show':
    case 'archive': {
      const parsed = parseCommand(rest, {}, 1);
      const id = parsed?.positionals[0];
      if (!parsed || id === undefined || !UUID.test(id)) return usage(ctx);
      const json = parsed.values.json === true;
      return withApi(ctx, json, async (client) => {
        const path = `/v1/eval-plans/${segment(id)}`;
        const plan =
          command === 'show'
            ? await client.get(path, evalPlanSchema)
            : await client.post(`${path}/archive`, evalPlanSchema);
        if (json) ctx.stdout(toJson(plan));
        else {
          printPlan(ctx, plan);
          say(ctx, 'cli.eval.plan.current', {
            trigger: plan.current.trigger,
            configurations: plan.current.configurations.map((c) => c.id).join(','),
            runs_per_task: plan.current.runs_per_task,
            budget: plan.current.budget_per_run_usd,
            cap: plan.current.monthly_cap_usd,
          });
        }
        return EXIT.ok;
      });
    }
    case 'create':
    case 'change': {
      const parsed = parseCommand(
        rest,
        {
          project: { type: 'string' },
          file: { type: 'string' },
          'expected-version': { type: 'string' },
        },
        command === 'change' ? 1 : 0,
      );
      const values = parsed?.values;
      const file = values?.file;
      if (!parsed || !values || typeof file !== 'string') return usage(ctx);
      const body = readPlanFile(ctx, file);
      if (body === undefined) return EXIT.usage;
      const json = values.json === true;
      if (command === 'create') {
        const project = values.project;
        if (typeof project !== 'string' || !SLUG.test(project)) return usage(ctx);
        return withApi(ctx, json, async (client) => {
          const plan = await client.post(
            `/v1/projects/${segment(project)}/eval-plans`,
            evalPlanSchema,
            body,
          );
          if (json) ctx.stdout(toJson(plan));
          else say(ctx, 'cli.eval.plan.created', { id: plan.id, code: plan.code });
          return EXIT.ok;
        });
      }
      const id = parsed.positionals[0];
      const expected = values['expected-version'];
      if (id === undefined || !UUID.test(id) || typeof expected !== 'string') return usage(ctx);
      if (!/^[1-9][0-9]{0,8}$/.test(expected)) return usage(ctx);
      return withApi(ctx, json, async (client) => {
        const plan = await client.post(`/v1/eval-plans/${segment(id)}/versions`, evalPlanSchema, {
          ...body,
          expected_version: Number(expected),
        });
        if (json) ctx.stdout(toJson(plan));
        else say(ctx, 'cli.eval.plan.changed', { id: plan.id, version: plan.version });
        return EXIT.ok;
      });
    }
    default:
      return usage(ctx);
  }
}

async function runRun(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const id = parsed?.positionals[0];
  if (!parsed || id === undefined || !UUID.test(id)) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const plan = await client.post(`/v1/eval-plans/${segment(id)}/runs`, evalPlanSchema);
    if (json) ctx.stdout(toJson(plan));
    else say(ctx, 'cli.eval.run.requested', { code: plan.code });
    return EXIT.ok;
  });
}

async function runList(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { project: { type: 'string' }, plan: { type: 'string' } });
  const values = parsed?.values;
  const project = values?.project;
  const plan = values?.plan;
  if (!values) return usage(ctx);
  if (project !== undefined && (typeof project !== 'string' || !SLUG.test(project))) {
    return usage(ctx);
  }
  if (plan !== undefined && (typeof plan !== 'string' || !UUID.test(plan))) return usage(ctx);
  const json = values.json === true;
  const query = new URLSearchParams();
  if (typeof project === 'string') query.set('project', project);
  if (typeof plan === 'string') query.set('plan', plan);
  return withApi(ctx, json, async (client) => {
    const list = await client.get(`/v1/evaluations?${query.toString()}`, evaluationListSchema);
    if (json) ctx.stdout(toJson(list));
    else if (list.evaluations.length === 0) say(ctx, 'cli.eval.none');
    else for (const evaluation of list.evaluations) printEvaluation(ctx, evaluation);
    return EXIT.ok;
  });
}

async function runShow(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const code = parsed?.positionals[0];
  if (!parsed || code === undefined || !EVAL_CODE.test(code)) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const evaluation = await client.get(`/v1/evaluations/${segment(code)}`, evaluationSchema);
    if (json) ctx.stdout(toJson(evaluation));
    else {
      printEvaluation(ctx, evaluation);
      if (evaluation.runs) {
        say(ctx, 'cli.eval.runs', { ...evaluation.runs, spent: show(evaluation.spent_usd) });
      }
    }
    return EXIT.ok;
  });
}

async function runReport(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const code = parsed?.positionals[0];
  if (!parsed || code === undefined || !EVAL_CODE.test(code)) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const report = await client.get(
      `/v1/evaluations/${segment(code)}/report`,
      evaluationReportSchema,
    );
    if (json) ctx.stdout(toJson(report));
    else printReport(ctx, report);
    return EXIT.ok;
  });
}

const pct = (value: number): string => `${String(Math.round(value * 100))}%`;

function printReport(ctx: CliContext, report: EvaluationReportView): void {
  printEvaluation(ctx, report.evaluation);
  say(ctx, report.final ? 'cli.eval.report.final' : 'cli.eval.report.not_final', {
    results: report.results,
  });
  for (const c of report.configurations) {
    say(ctx, 'cli.eval.report.configuration', {
      configuration: c.configuration,
      model: c.model,
      tasks: c.tasks,
      runs: c.runs,
      resolved: pct(c.resolved.estimate),
      low: pct(c.resolved.low),
      high: pct(c.resolved.high),
      k: c.k,
      pass_at_k: pct(c.pass_at_k),
      pass_hat_k: pct(c.pass_hat_k),
      ci_first_try: pct(c.ci_first_try),
      cost_per_run: c.cost_per_run_usd,
      cost_per_resolved: show(c.cost_per_resolved_usd),
    });
  }
  for (const c of report.comparisons) {
    say(ctx, c.better === null ? 'cli.eval.report.no_difference' : 'cli.eval.report.difference', {
      a: c.a,
      b: c.b,
      better: show(c.better),
      tasks: c.paired_tasks,
      p: c.p_value,
    });
  }
  if (report.recommendations.length === 0) say(ctx, 'cli.eval.report.no_recommendation');
  for (const rec of report.recommendations) {
    say(ctx, 'cli.eval.report.recommendation', {
      text: recommendationText(rec),
    });
  }
  const real = report.real_runs;
  if (real === null || !real.available) say(ctx, 'cli.eval.report.real_runs_hidden');
  else if (real.rows.length === 0) say(ctx, 'cli.eval.report.real_runs_none');
  else {
    for (const row of real.rows) {
      say(ctx, 'cli.eval.report.real_run', {
        agent: row.agent,
        version: row.agent_version,
        model: row.model,
        runs: row.runs.total,
        ci: `${String(row.ci.first_try_passed)}/${String(row.ci.first_try_total)}`,
        merged: row.merged.intents,
        without_changes: row.merged.without_changes_requested,
        cost_per_run: show(row.cost.per_run_usd),
      });
    }
  }
}

/** A recommendation's text; an unknown rule (a newer server) shows its code. */
function recommendationText(rec: EvaluationReportView['recommendations'][number]): string {
  const key = recommendationKey(rec.rule);
  if (key === undefined) return rec.rule;
  const params = { configuration: rec.configuration, other: rec.other ?? '', ...rec.numbers };
  return `${t(key, params)} ${t('eval.recommendation.register_note')}`;
}

/** The plan file: JSON, at most 64 KB, an object. Never printed back. */
function readPlanFile(ctx: CliContext, file: string): Record<string, unknown> | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('size');
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error('shape');
    return value as Record<string, unknown>;
  } catch {
    ctx.stderr(t('cli.eval.file_unreadable'));
    return undefined;
  }
}

function printPlan(ctx: CliContext, plan: EvalPlanSummaryView): void {
  say(ctx, 'cli.eval.plan.line', {
    id: plan.id,
    code: plan.code,
    version: plan.version,
    status: plan.status,
    next_run_at: show(plan.next_run_at),
    requested: show(plan.run_requested_at),
    refusal: show(plan.last_refusal),
  });
}

function printEvaluation(ctx: CliContext, evaluation: EvaluationView): void {
  say(ctx, 'cli.eval.line', {
    code: evaluation.code,
    status: evaluation.status,
    stop_reason: show(evaluation.stop_reason),
    budget: evaluation.budget_usd,
    created_at: evaluation.created_at,
  });
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.eval.usage'));
  return EXIT.usage;
}
