// `sdlc next <INT> [--json]` (task V06): where an intent is and what the signed-in person does
// next. Reads `GET /v1/me` and `GET /v1/intents/:intent` only (no new endpoint; QUESTIONS #368,
// #369); the advice comes from `next/advice.ts`, every text from the catalog (`cli.next.*`).
import { isHold, WAITING_CAUSE_KEYS, WAITING_REASON_KEYS } from '@sdlc/api-schemas';
import { t, type MessageKey } from '@sdlc/messages';

import { intentDetailSchema, meSchema, type IntentDetail } from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, sayError, show, toJson } from '../output.js';
import { intentRef } from './intent.js';
import { adviceKey, adviseNext, noteKey, type Advice } from './next/advice.js';

export async function runNext(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  if (!parsed || ref === undefined) {
    sayError(ctx, 'cli.next.usage');
    return EXIT.usage;
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const [me, intent] = await Promise.all([
      client.get('/v1/me', meSchema),
      client.get(`/v1/intents/${segment(ref)}`, intentDetailSchema),
    ]);
    const next = adviseNext(intent, me);
    if (json) ctx.stdout(toJson(jsonView(intent, next)));
    else print(ctx, intent, next);
    return EXIT.ok;
  });
}

/** The advice's text, with the comment hint of a gate decision when the intent has an issue. */
export function adviceText(next: Advice): string {
  const { gate, issue } = next.params;
  const comment =
    issue !== undefined && issue !== '-' && gate !== undefined
      ? t('cli.next.comment_hint', { gate, issue })
      : '';
  return t(adviceKey(next.code), { ...next.params, comment });
}

function label(keys: Readonly<Record<string, string>>, code: string): string {
  const key = keys[code];
  return key ? t(key as MessageKey) : code;
}

function print(ctx: CliContext, intent: IntentDetail, next: Advice): void {
  say(ctx, 'cli.next.header', {
    intent: intent.code,
    project: intent.project.slug,
    status: intent.status,
    gate: show(intent.current_gate),
  });
  const waiting = intent.waiting_for;
  if (waiting) {
    say(ctx, 'cli.next.waiting_for', {
      gate: waiting.gate,
      mode: waiting.mode,
      roles: waiting.roles.join(', ') || '-',
      needed: waiting.approvals_needed,
    });
  }
  if (isHold(intent.waiting_reason)) {
    say(ctx, 'cli.intent.waiting', {
      reason: label(WAITING_REASON_KEYS, intent.waiting_reason),
      since: show(intent.waiting_since),
    });
    if (intent.waiting_cause) {
      say(ctx, 'cli.intent.waiting_cause', {
        cause: label(WAITING_CAUSE_KEYS, intent.waiting_cause),
      });
    }
    if (intent.waiting_until) say(ctx, 'cli.intent.waiting_until', { until: intent.waiting_until });
  }
  say(ctx, 'cli.next.next', { text: adviceText(next) });
  for (const note of next.notes) say(ctx, 'cli.next.note_line', { text: t(noteKey(note)) });
}

/** `--json`: codes and the rendered advice; the same facts as the text output. */
function jsonView(intent: IntentDetail, next: Advice): Record<string, unknown> {
  return {
    intent: intent.code,
    project: intent.project.slug,
    status: intent.status,
    gate: intent.current_gate,
    waiting_for: intent.waiting_for,
    waiting_reason: intent.waiting_reason ?? null,
    waiting_cause: intent.waiting_cause ?? null,
    waiting_until: intent.waiting_until ?? null,
    advice: {
      kind: next.kind,
      code: next.code,
      text: adviceText(next),
      roles: next.roles,
      producer: next.producer,
      notes: next.notes,
    },
  };
}
