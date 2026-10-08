// `sdlc plan draft <INT-…> --from <file> --tool spec-kit|bmad [--output <file>] [--force] [--json]`
// (task S02, D-08 S02, design/ADR-M62, handbook Ch.19 §19.8c). Writes a plan file draft
// (schema version 1) from a Spec Kit `tasks.md` or a BMAD story file on this machine. No API call,
// no Git command: the draft is never submitted, committed or pushed (QUESTIONS #167). The fields a
// person decides are left `null`, so submission refuses the file until they are filled.
// The default file is `.sdlc/plans/<INT-…>.yaml` in the nearest folder (this one or a parent) that
// holds `.git`; an existing file is replaced only with `--force`.
import { constants, existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

import {
  DRAFT_INPUT_MAX_BYTES,
  DRAFT_REFUSAL_MESSAGES,
  PLAN_REFUSAL_MESSAGES,
  DRAFT_TOOLS,
  INTENT_CODE_PATTERN,
  draftPlan,
  planPath,
  type DraftRefusal,
  type DraftTool,
} from '@sdlc/core';
import { t } from '@sdlc/messages';

import { parseCommand } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { clean, say, sayError, toJson } from '../output.js';

type Refused = { readonly refusal: DraftRefusal; readonly params?: Record<string, string> };

function isTool(value: unknown): value is DraftTool {
  return (DRAFT_TOOLS as readonly unknown[]).includes(value);
}

export async function draft(
  args: readonly string[],
  ctx: CliContext,
  usage: (ctx: CliContext) => number,
): Promise<number> {
  const parsed = parseCommand(
    args,
    {
      from: { type: 'string' },
      tool: { type: 'string' },
      output: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    1,
  );
  const intent = parsed?.positionals[0]?.toUpperCase() ?? '';
  const values = parsed?.values;
  const { from, tool, output } = values ?? {};
  if (
    !values ||
    !INTENT_CODE_PATTERN.test(intent) ||
    typeof from !== 'string' ||
    from.length === 0 ||
    !isTool(tool) ||
    (output !== undefined && (typeof output !== 'string' || output.length === 0))
  ) {
    return usage(ctx);
  }
  const json = values.json === true;
  const cwd = ctx.cwd ?? process.cwd();

  const input = await readSource(path.resolve(cwd, from));
  if ('refusal' in input) return refuse(ctx, input);
  const result = draftPlan({ text: input.text, tool, intentCode: intent });
  if (!result.ok) {
    const refusal = result.planRefusal ? t(PLAN_REFUSAL_MESSAGES[result.planRefusal]) : '-';
    return refuse(ctx, { refusal: result.refusal, params: { refusal } });
  }

  const target =
    typeof output === 'string' ? path.resolve(cwd, output) : defaultTarget(cwd, intent);
  if (target === null) return refuse(ctx, { refusal: 'no_repository' });
  const shown = displayPath(cwd, target);
  try {
    if (typeof output !== 'string') await mkdir(path.dirname(target), { recursive: true });
    await writePlan(target, result.yaml, values.force === true);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return code === 'EEXIST'
      ? refuse(ctx, { refusal: 'output_exists', params: { path: shown } })
      : refuse(ctx, { refusal: 'write_failed', params: { path: shown, code } });
  }

  if (json) {
    ctx.stdout(
      toJson({
        intent,
        path: target,
        tool,
        tasks: result.tasks,
        grouped: result.grouped,
        unfilled: result.unfilled,
      }),
    );
    return EXIT.ok;
  }
  say(ctx, 'cli.plan.draft.written', { intent, path: shown, tasks: result.tasks, tool });
  if (result.grouped) say(ctx, 'cli.plan.draft.grouped');
  say(ctx, 'cli.plan.draft.unfilled');
  // Field paths are built by the draft from fixed keys and positions: no text from the file.
  for (const field of result.unfilled) ctx.stdout(`  - ${field}`);
  say(ctx, 'cli.plan.draft.next', { intent });
  return EXIT.ok;
}

/**
 * Writes the plan file. Without `force` an existing file is refused (`EEXIST`); with it the file
 * is replaced, but never through a symbolic link (`O_NOFOLLOW`: `ELOOP`).
 */
async function writePlan(target: string, yaml: string, force: boolean): Promise<void> {
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

/** The source file: a regular file of at most 256 KiB, strict UTF-8. */
async function readSource(file: string): Promise<{ text: string } | Refused> {
  let handle;
  try {
    // Non-blocking: a FIFO is refused by the check below instead of waiting for a writer.
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return { refusal: 'input_missing' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { refusal: 'input_not_a_file' };
    if (stat.size > DRAFT_INPUT_MAX_BYTES) return { refusal: 'input_too_large' };
    const bytes = await handle.readFile();
    if (bytes.length > DRAFT_INPUT_MAX_BYTES) return { refusal: 'input_too_large' };
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { refusal: 'input_not_utf8' };
    }
  } catch {
    return { refusal: 'input_not_a_file' };
  } finally {
    await handle.close();
  }
}

/**
 * `.sdlc/plans/<INT>.yaml` in the nearest folder, from `cwd` up, that holds `.git` (a folder, or
 * the file of a Git worktree). A check of the folder only: no Git command runs. Null: none found.
 */
export function defaultTarget(cwd: string, intent: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return path.join(dir, ...planPath(intent).split('/'));
    if (path.dirname(dir) === dir) return null;
  }
}

/** The path as the person would type it from `cwd` (absolute on another drive). */
function displayPath(cwd: string, target: string): string {
  const relative = path.relative(cwd, target);
  return relative.length > 0 && !path.isAbsolute(relative) ? relative : target;
}

function refuse(ctx: CliContext, refused: Refused): number {
  const params = Object.fromEntries(
    Object.entries(refused.params ?? {}).map(([key, value]) => [key, clean(value)]),
  );
  const reason = t(DRAFT_REFUSAL_MESSAGES[refused.refusal], params);
  sayError(ctx, 'cli.plan.draft.refused', { reason });
  return EXIT.failed;
}
