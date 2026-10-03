// `sdlc run list|kill` over the API (task C11, D-08 C11 AC1, D-02 FR-34, ADR-M42 §2.6, handbook
// Ch.18 §18.8d). `kill` takes a run ID or an intent code (its current run). Who may kill: project
// config `access.kill_roles` (Person A, Person B and governance always; never `viewer`). The
// platform records the kill at once; the run stops and its keys and tokens are revoked within
// minutes, and an escalation is raised for the review. Killing twice changes nothing.
import { t } from '@sdlc/messages';

import { killResultSchema, runListSchema, type RunView } from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, toJson } from '../output.js';
import { intentRef } from './intent.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses of a run that can still be stopped. */
const ACTIVE = new Set(['queued', 'provisioning', 'running']);

export async function runRun(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'list') return list(rest, ctx);
  if (command === 'kill') return kill(rest, ctx);
  return usage(ctx);
}

async function list(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  if (!parsed || ref === undefined) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const page = await client.get(`/v1/intents/${segment(ref)}/runs`, runListSchema);
    if (json) {
      ctx.stdout(toJson(page));
      return EXIT.ok;
    }
    if (page.items.length === 0) {
      say(ctx, 'cli.run.none', { intent: page.intent });
      return EXIT.ok;
    }
    for (const run of page.items) say(ctx, 'cli.run.row', row(run));
    return EXIT.ok;
  });
}

function row(run: RunView): Record<string, string | number> {
  return {
    attempt: run.attempt,
    id: run.id,
    status: run.status,
    stop_reason: run.stop_reason ?? '-',
    iterations: run.iterations,
    started: run.started_at ?? '-',
  };
}

async function kill(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const target = parsed?.positionals[0] ?? '';
  const runId = UUID.test(target) ? target.toLowerCase() : undefined;
  const intent = runId === undefined ? intentRef(target) : undefined;
  if (!parsed || (runId === undefined && intent === undefined)) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    let id = runId;
    if (id === undefined) {
      const page = await client.get(`/v1/intents/${segment(intent!)}/runs`, runListSchema);
      id = page.items.filter((run) => ACTIVE.has(run.status)).at(-1)?.id;
      if (id === undefined) {
        if (json) ctx.stdout(toJson({ intent: page.intent, run: null }));
        else say(ctx, 'cli.run.no_active', { intent: page.intent });
        return EXIT.failed;
      }
    }
    const result = await client.post(`/v1/runs/${segment(id)}/kill`, killResultSchema);
    if (json) ctx.stdout(toJson(result));
    else {
      say(ctx, result.already ? 'cli.run.already_killed' : 'cli.run.killed', {
        run: result.run,
        intent: result.intent,
        status: result.status,
        escalation: result.escalation ?? '-',
      });
    }
    return EXIT.ok;
  });
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.run.usage'));
  return EXIT.usage;
}
