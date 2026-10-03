// `sdlc plan submit|list|show` over the API (D-08 B09 AC2, ADR-M40 §2.3, handbook Ch.19 §19.8c).
// The plan is the file `.sdlc/plans/<INT-…>.yaml` on the default branch (template T13). The
// platform reads it from the Git host and keeps its SHA-256, path patterns, tools and change flags
// only; the text stays in the repository. `--commit` is optional and must hold the same file as
// the head (409 `plan_not_on_default_branch`). Who may submit: project config
// `access.plan_submit_roles` (default Person A); the submitter never approves G3.
import { t } from '@sdlc/messages';

import { planListSchema, submittedPlanSchema, type PlanVersionView } from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, toJson } from '../output.js';
import { intentRef } from './intent.js';

const COMMIT = /^[0-9a-f]{40}$/;

export async function runPlan(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'submit') return submit(rest, ctx);
  if (command === 'list') return list(rest, ctx, false);
  if (command === 'show') return list(rest, ctx, true);
  return usage(ctx);
}

function flags(plan: PlanVersionView): string {
  return plan.change_flags.join(',') || t('cli.plan.no_flags');
}

async function submit(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { commit: { type: 'string' } }, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  const values = parsed?.values;
  const commit = values?.commit;
  if (!values || ref === undefined || (typeof commit === 'string' && !COMMIT.test(commit))) {
    return usage(ctx);
  }
  const json = values.json === true;
  return withApi(ctx, json, async (client) => {
    const plan = await client.post(
      `/v1/intents/${segment(ref)}/plans`,
      submittedPlanSchema,
      typeof commit === 'string' ? { commit_sha: commit } : {},
    );
    if (json) ctx.stdout(toJson(plan));
    else {
      say(ctx, 'cli.plan.submitted', {
        intent: plan.intent,
        version: plan.version,
        commit: plan.commit_sha ?? '-',
        sha256: plan.plan_sha256,
        paths: plan.planned_files.length,
        tools: (plan.allowed_tools ?? []).join(',') || '-',
        flags: flags(plan),
      });
    }
    return EXIT.ok;
  });
}

/** `list` prints every version; `show` the latest one with its path patterns. */
async function list(args: readonly string[], ctx: CliContext, latest: boolean): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  if (!parsed || ref === undefined) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const page = await client.get(`/v1/intents/${segment(ref)}/plans`, planListSchema);
    const last = page.items.at(-1);
    if (json) {
      ctx.stdout(toJson(latest ? { intent: page.intent, plan: last ?? null } : page));
      return EXIT.ok;
    }
    if (!last) {
      say(ctx, 'cli.plan.none', { intent: page.intent });
      return EXIT.ok;
    }
    if (latest) {
      say(ctx, 'cli.plan.detail', {
        intent: page.intent,
        version: last.version,
        commit: last.commit_sha ?? '-',
        sha256: last.plan_sha256,
        tools: (last.allowed_tools ?? []).join(',') || '-',
        flags: flags(last),
        paths: last.planned_files.map((file) => `    ${file}`).join('\n'),
      });
      return EXIT.ok;
    }
    for (const plan of page.items) {
      say(ctx, 'cli.plan.row', {
        version: plan.version,
        commit: plan.commit_sha ?? '-',
        sha256: plan.plan_sha256,
        flags: flags(plan),
      });
    }
    return EXIT.ok;
  });
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.plan.usage'));
  return EXIT.usage;
}
