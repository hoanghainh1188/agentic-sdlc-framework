// `sdlc escalation list|show|ack|decide` over the API (D-08 B04 AC4, QUESTIONS #77; design/
// ADR-M28 §2.7, handbook Ch.18 §18.8b). The decision words are the same as `/decide` in a comment.
// Codes and one https link only: escalations are kept 2 years and never hold free text.
import { ESCALATION_STATUSES, GATE_REASON_CODES, PROTECTED_ACTIONS } from '@sdlc/contracts';
import { DECISION_WORDS, ESCALATION_CODE_PATTERN } from '@sdlc/core';
import { t } from '@sdlc/messages';

import { escalationListSchema, escalationSchema, type EscalationView } from '../api/schemas.js';
import { parseCommand, segment, withApi, type Values } from '../api/session.js';
import type { ApiClient } from '../api/client.js';
import { EXIT, type CliContext } from '../context.js';
import { say, show, toJson } from '../output.js';
import { HTTPS_REF } from './gate.js';
import { intentRef } from './intent.js';

const MAX_PAGE = 100;
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/;

/** The words of `sdlc escalation decide`: those of the `/decide` comment, with dashes. */
const CLI_DECISION_WORDS = ['resume', 'modify', 'roll-back', 'terminate', 'escalate'] as const;

export async function runEscalation(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'list') return list(rest, ctx);
  if (command === 'show' || command === 'ack') return single(command, rest, ctx);
  if (command === 'decide') return decide(rest, ctx);
  return usage(ctx);
}

function escalationCode(value: string | undefined): string | undefined {
  const upper = value?.toUpperCase();
  return upper !== undefined && ESCALATION_CODE_PATTERN.test(upper) ? upper : undefined;
}

async function list(args: readonly string[], ctx: CliContext): Promise<number> {
  const values = parseCommand(args, {
    intent: { type: 'string' },
    status: { type: 'string' },
    limit: { type: 'string' },
  })?.values;
  if (!values) return usage(ctx);
  const intent = typeof values.intent === 'string' ? intentRef(values.intent) : undefined;
  const limit = typeof values.limit === 'string' ? Number(values.limit) : undefined;
  if (
    (typeof values.intent === 'string' && intent === undefined) ||
    (typeof values.status === 'string' &&
      !(ESCALATION_STATUSES as readonly string[]).includes(values.status)) ||
    (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE))
  ) {
    return usage(ctx);
  }
  const json = values.json === true;
  return withApi(ctx, json, async (client) => {
    const page = await client.get('/v1/escalations', escalationListSchema, {
      intent,
      status: values.status as string | undefined,
      limit,
    });
    if (json) {
      ctx.stdout(toJson(page));
      return EXIT.ok;
    }
    if (page.items.length === 0) say(ctx, 'cli.escalation.none');
    for (const item of page.items) say(ctx, 'cli.escalation.line', lineParams(item));
    return EXIT.ok;
  });
}

async function single(
  command: 'show' | 'ack',
  args: readonly string[],
  ctx: CliContext,
): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const code = escalationCode(parsed?.positionals[0]);
  if (!parsed || code === undefined) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const escalation =
      command === 'show'
        ? await client.get(`/v1/escalations/${segment(code)}`, escalationSchema)
        : await client.post(`/v1/escalations/${segment(code)}/ack`, escalationSchema);
    return print(ctx, json, escalation, command === 'ack' ? 'cli.escalation.acknowledged' : null);
  });
}

async function decide(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(
    args,
    {
      'reason-code': { type: 'string' },
      'reason-ref': { type: 'string' },
      actions: { type: 'string' },
      'budget-increase-usd': { type: 'string' },
    },
    2,
  );
  const code = escalationCode(parsed?.positionals[0]);
  const word = parsed?.positionals[1]?.toLowerCase();
  const decision =
    word !== undefined && (CLI_DECISION_WORDS as readonly string[]).includes(word)
      ? DECISION_WORDS[word]
      : undefined;
  const body = parsed ? decisionBody(parsed.values) : undefined;
  if (!parsed || code === undefined || decision === undefined || body === undefined) {
    return usage(ctx);
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client: ApiClient) => {
    const escalation = await client.post(
      `/v1/escalations/${segment(code)}/decisions`,
      escalationSchema,
      { decision, ...body },
    );
    return print(ctx, json, escalation, 'cli.escalation.decided');
  });
}

/** The optional fields of a decision, or undefined when one is not valid. */
function decisionBody(values: Values): Record<string, unknown> | undefined {
  const reasonCode = values['reason-code'];
  const reasonRef = values['reason-ref'];
  const actions = values.actions;
  const budget = values['budget-increase-usd'];
  const list =
    typeof actions === 'string' ? actions.split(',').map((item) => item.trim()) : undefined;
  if (
    (typeof reasonCode === 'string' &&
      !(GATE_REASON_CODES as readonly string[]).includes(reasonCode)) ||
    (typeof reasonRef === 'string' && !HTTPS_REF.test(reasonRef)) ||
    (list !== undefined &&
      !list.every((item) => (PROTECTED_ACTIONS as readonly string[]).includes(item))) ||
    (typeof budget === 'string' && !DECIMAL.test(budget))
  ) {
    return undefined;
  }
  return {
    ...(typeof reasonCode === 'string' ? { reason_code: reasonCode } : {}),
    ...(typeof reasonRef === 'string' ? { reason_ref: reasonRef } : {}),
    ...(list === undefined ? {} : { actions: [...new Set(list)] }),
    ...(typeof budget === 'string' ? { budget_increase_usd: budget } : {}),
  };
}

function print(
  ctx: CliContext,
  json: boolean,
  escalation: EscalationView,
  done: 'cli.escalation.acknowledged' | 'cli.escalation.decided' | null,
): number {
  if (json) {
    ctx.stdout(toJson(escalation));
    return EXIT.ok;
  }
  if (done !== null) say(ctx, done, { code: escalation.code, status: escalation.status });
  say(ctx, 'cli.escalation.detail', {
    ...lineParams(escalation),
    trigger: escalation.trigger,
    owner: show(escalation.owner_id),
    backup: show(escalation.backup_owner_id),
    ack_due: show(escalation.ack_due_at),
    step_due: show(escalation.step_due_at),
    resolve_due: show(escalation.resolve_due_at),
    acknowledged_at: show(escalation.acknowledged_at),
    decision: show(codeOf(escalation.decision)),
    decided_at: show(escalation.decided_at),
    reason: show(codeOf(escalation.packet, 'reason_code')),
    run: show(escalation.run_id),
  });
  return EXIT.ok;
}

function lineParams(item: EscalationView): Record<string, string> {
  return {
    code: item.code,
    intent: item.intent.code,
    status: item.status,
    severity: item.severity,
    level: item.response_level,
    route: item.route,
    step: item.current_step,
    freezes: item.freezes_intent ? t('cli.escalation.frozen') : '-',
  };
}

/** A string field of a coded object (decision or packet), or undefined. */
function codeOf(value: Record<string, unknown> | null, field = 'decision'): string | undefined {
  const found = value?.[field];
  return typeof found === 'string' ? found : undefined;
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.escalation.usage'));
  return EXIT.usage;
}
