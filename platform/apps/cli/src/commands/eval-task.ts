// `adlc eval task …`: a project's own evaluation tasks (task L07, design/ADR-M85 §2.2, §2.6).
// - `draft <INT-…> --project <slug> --task <id> [--output <file>] [--force]`: asks the API for the
//   facts of the merged intent and writes the card on this machine (default
//   `.sdlc/eval-tasks/<id>.yaml` in the repository folder). Nothing is sent back: the person adds the
//   commands if the project configuration proposes none, and commits the card through a pull
//   request. An existing file is refused unless `--force`; never through a symbolic link.
// - `register <id> --project <slug>`: the platform reads the card from the default branch.
// - `list --project <slug>`; `approve <task-uuid> --card <sha256>`;
//   `reject <task-uuid> --card <sha256> --reason <code>`: the decision is bound to the card the
//   reviewer saw (its SHA-256, shown by `list`).
// Every command goes through the API and has `--json`.
import { constants, existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import { renderTaskCard, taskCardPath, type TaskCard } from '@sdlc/eval';
import { t } from '@sdlc/messages';

import {
  evalTaskDraftSchema,
  evalTaskListSchema,
  evalTaskRegisteredSchema,
  evalTaskReviewedSchema,
  type EvalTaskCardView,
  type EvalTaskView,
} from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { clean, say, sayError, toJson } from '../output.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INTENT = /^INT-[0-9]{4}-[0-9]{4,9}$/;
const TASK_ID = /^[a-z][a-z0-9-]{1,47}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REASONS = ['not_representative', 'tests_weak', 'too_large', 'needs_environment', 'other'];
const OUTCOME_KEYS = {
  created: 'cli.eval.task.created',
  changed: 'cli.eval.task.changed',
  unchanged: 'cli.eval.task.unchanged',
} as const;
const REVIEW_KEYS = {
  approve: 'cli.eval.task.approved',
  reject: 'cli.eval.task.rejected',
} as const;

export async function runEvalTask(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case 'draft':
      return draft(rest, ctx);
    case 'register':
      return register(rest, ctx);
    case 'list':
      return list(rest, ctx);
    case 'approve':
    case 'reject':
      return review(command, rest, ctx);
    default:
      return usage(ctx);
  }
}

function cardOf(view: EvalTaskCardView): TaskCard {
  return {
    id: view.id,
    intent: view.intent,
    baseCommit: view.base_commit,
    mergeCommit: view.merge_commit,
    spec: { ...view.spec },
    hiddenTests: view.hidden_tests,
    plannedFiles: view.planned_files,
    failToPass: view.fail_to_pass,
    passToPass: view.pass_to_pass,
    ci: view.ci,
  };
}

/** The card's path in the nearest folder, from `cwd` up, that holds `.git`. Null: none. */
export function defaultCardTarget(cwd: string, taskId: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) {
      return path.join(dir, ...taskCardPath(taskId).split('/'));
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** Writes the card; an existing file is refused without `force`, a link always (`O_NOFOLLOW`). */
async function writeCard(target: string, yaml: string, force: boolean): Promise<void> {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (force ? constants.O_TRUNC : constants.O_EXCL);
  const handle = await open(target, flags, 0o644);
  try {
    await handle.writeFile(yaml, 'utf8');
  } finally {
    await handle.close();
  }
}

async function draft(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(
    args,
    {
      project: { type: 'string' },
      task: { type: 'string' },
      output: { type: 'string' },
      force: { type: 'boolean' },
    },
    1,
  );
  const intent = parsed?.positionals[0];
  const values = parsed?.values;
  const project = values?.project;
  const task = values?.task;
  if (
    !parsed ||
    !values ||
    intent === undefined ||
    !INTENT.test(intent) ||
    typeof project !== 'string' ||
    !SLUG.test(project) ||
    typeof task !== 'string' ||
    !TASK_ID.test(task)
  ) {
    return usage(ctx);
  }
  const cwd = ctx.cwd ?? process.cwd();
  const output = values.output;
  const target =
    typeof output === 'string' ? path.resolve(cwd, output) : defaultCardTarget(cwd, task);
  if (target === null) {
    sayError(ctx, 'cli.eval.task.no_repository');
    return EXIT.failed;
  }
  const json = values.json === true;
  return withApi(ctx, json, async (client) => {
    const { card } = await client.get(
      `/v1/projects/${segment(project)}/eval-tasks/draft`,
      evalTaskDraftSchema,
      { intent, task },
    );
    try {
      if (typeof output !== 'string') await mkdir(path.dirname(target), { recursive: true });
      await writeCard(target, renderTaskCard(cardOf(card)), values.force === true);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      sayError(ctx, code === 'EEXIST' ? 'cli.eval.task.exists' : 'cli.eval.task.not_written', {
        path: clean(target),
      });
      return EXIT.failed;
    }
    const shown = path.relative(cwd, target) || target;
    const empty =
      card.fail_to_pass.length === 0 || card.pass_to_pass.length === 0 || card.ci.length === 0;
    if (json) {
      ctx.stdout(toJson({ path: shown, commands_missing: empty, card }));
      return EXIT.ok;
    }
    say(ctx, 'cli.eval.task.drafted', {
      path: clean(shown),
      intent,
      tests: card.hidden_tests.length,
      files: card.planned_files.length,
    });
    if (empty) say(ctx, 'cli.eval.task.fill_commands');
    say(ctx, 'cli.eval.task.next', { project, task });
    return EXIT.ok;
  });
}

async function register(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { project: { type: 'string' } }, 1);
  const task = parsed?.positionals[0];
  const project = parsed?.values.project;
  if (
    !parsed ||
    task === undefined ||
    !TASK_ID.test(task) ||
    typeof project !== 'string' ||
    !SLUG.test(project)
  ) {
    return usage(ctx);
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const result = await client.post(
      `/v1/projects/${segment(project)}/eval-tasks`,
      evalTaskRegisteredSchema,
      { task },
    );
    if (json) ctx.stdout(toJson(result));
    else {
      say(ctx, OUTCOME_KEYS[result.outcome], { task });
      printTask(ctx, result.task);
    }
    return EXIT.ok;
  });
}

async function list(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { project: { type: 'string' } });
  const project = parsed?.values.project;
  if (!parsed || typeof project !== 'string' || !SLUG.test(project)) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const result = await client.get(
      `/v1/projects/${segment(project)}/eval-tasks`,
      evalTaskListSchema,
    );
    if (json) ctx.stdout(toJson(result));
    else if (result.tasks.length === 0) say(ctx, 'cli.eval.task.none', { project });
    else for (const task of result.tasks) printTask(ctx, task);
    return EXIT.ok;
  });
}

async function review(
  command: 'approve' | 'reject',
  args: readonly string[],
  ctx: CliContext,
): Promise<number> {
  const parsed = parseCommand(args, { card: { type: 'string' }, reason: { type: 'string' } }, 1);
  const id = parsed?.positionals[0];
  const card = parsed?.values.card;
  const reason = parsed?.values.reason;
  if (
    !parsed ||
    id === undefined ||
    !UUID.test(id) ||
    typeof card !== 'string' ||
    !SHA256.test(card) ||
    (command === 'reject' && (typeof reason !== 'string' || !REASONS.includes(reason))) ||
    (command === 'approve' && reason !== undefined)
  ) {
    return usage(ctx);
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const result = await client.post(
      `/v1/eval-tasks/${segment(id)}/${command}`,
      evalTaskReviewedSchema,
      command === 'reject' ? { card_sha256: card, reason } : { card_sha256: card },
    );
    if (json) ctx.stdout(toJson(result));
    else say(ctx, REVIEW_KEYS[command], { task: result.task.task });
    return EXIT.ok;
  });
}

function printTask(ctx: CliContext, task: EvalTaskView): void {
  say(ctx, 'cli.eval.task.line', {
    task: task.task,
    id: task.id,
    intent: task.intent,
    status: task.status,
    check: task.check_code ?? '-',
    card: task.card_sha256,
  });
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.eval.task.usage'));
  return EXIT.usage;
}
