// `sdlc intent create|list|show` over the API (D-08 B04 AC1, FR-20; ADR-M26 §2.8).
import { readFile } from 'node:fs/promises';

import { DATA_CLASSES, INTENT_STATUSES, RISK_TIERS } from '@sdlc/contracts';
import { INTENT_CODE_PATTERN } from '@sdlc/core';
import { t } from '@sdlc/messages';

import {
  intentDetailSchema,
  intentPageSchema,
  intentSchema,
  type DecisionView,
  type IntentDetail,
  type IntentView,
} from '../api/schemas.js';
import { CommandExit, parseCommand, segment, withApi, type Values } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, sayError, show, toJson } from '../output.js';

/** The API's limits (ADR-M26 §2.8, `createIntentSchema`). */
const MAX_DESCRIPTION = 10_000;
const MAX_PAGE = 100;
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPTIONS = {
  create: {
    project: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    'description-file': { type: 'string' },
    risk: { type: 'string' },
    'data-class': { type: 'string' },
    budget: { type: 'string' },
    issue: { type: 'string' },
  },
  list: {
    project: { type: 'string' },
    status: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
  },
  show: {},
} as const;

export async function runIntent(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'create') return create(rest, ctx);
  if (command === 'list') return list(rest, ctx);
  if (command === 'show') return showIntent(rest, ctx);
  return usage(ctx);
}

/** An intent code (any case) or UUID, as the API expects it; undefined when neither. */
export function intentRef(value: string): string | undefined {
  const upper = value.toUpperCase();
  if (INTENT_CODE_PATTERN.test(upper)) return upper;
  return UUID.test(value) ? value.toLowerCase() : undefined;
}

async function create(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, OPTIONS.create);
  const values = parsed?.values;
  if (!values || !validCreate(values)) return usage(ctx);
  const json = values.json === true;
  return withApi(ctx, json, async (client) => {
    const body = {
      project: String(values.project),
      title: String(values.title),
      description: await description(ctx, values),
      risk_tier: String(values.risk),
      data_class: String(values['data-class']),
      ...(typeof values.budget === 'string' ? { budget_usd: values.budget } : {}),
      ...(typeof values.issue === 'string' ? { issue_number: Number(values.issue) } : {}),
    };
    const intent = await client.post('/v1/intents', intentSchema, body);
    if (json) ctx.stdout(toJson(intent));
    else say(ctx, 'cli.intent.created', summary(intent));
    return EXIT.ok;
  });
}

function validCreate(values: Values): boolean {
  if (!['project', 'title', 'risk', 'data-class'].every((k) => typeof values[k] === 'string')) {
    return false;
  }
  if (values.description !== undefined && values['description-file'] !== undefined) return false;
  if (!(RISK_TIERS as readonly string[]).includes(String(values.risk))) return false;
  if (!(DATA_CLASSES as readonly string[]).includes(String(values['data-class']))) return false;
  if (typeof values.budget === 'string' && !DECIMAL.test(values.budget)) return false;
  if (typeof values.issue === 'string' && !/^[1-9]\d{0,8}$/.test(values.issue)) return false;
  return true;
}

async function description(ctx: CliContext, values: Values): Promise<string> {
  const file = values['description-file'];
  const text =
    typeof file === 'string'
      ? await readFile(file, 'utf8').catch(() => {
          sayError(ctx, 'cli.intent.description_unreadable', { file });
          throw new CommandExit(EXIT.usage);
        })
      : typeof values.description === 'string'
        ? values.description
        : '';
  if (text.length > MAX_DESCRIPTION) {
    sayError(ctx, 'cli.intent.description_too_long', { max: MAX_DESCRIPTION });
    throw new CommandExit(EXIT.usage);
  }
  return text;
}

async function list(args: readonly string[], ctx: CliContext): Promise<number> {
  const values = parseCommand(args, OPTIONS.list)?.values;
  if (!values) return usage(ctx);
  if (
    typeof values.status === 'string' &&
    !(INTENT_STATUSES as readonly string[]).includes(values.status)
  ) {
    return usage(ctx);
  }
  const limit = typeof values.limit === 'string' ? Number(values.limit) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE)) {
    return usage(ctx);
  }
  const json = values.json === true;
  return withApi(ctx, json, async (client) => {
    const page = await client.get('/v1/intents', intentPageSchema, {
      project: values.project as string | undefined,
      status: values.status as string | undefined,
      limit,
      cursor: values.cursor as string | undefined,
    });
    if (json) {
      ctx.stdout(toJson(page));
      return EXIT.ok;
    }
    if (page.items.length === 0) say(ctx, 'cli.intent.none');
    for (const intent of page.items) {
      say(ctx, 'cli.intent.line', {
        code: intent.code,
        status: intent.status,
        gate: show(intent.current_gate),
        risk: intent.risk_tier,
        project: intent.project.slug,
        title: intent.title,
      });
    }
    if (page.next_cursor !== null) say(ctx, 'cli.intent.more', { cursor: page.next_cursor });
    return EXIT.ok;
  });
}

async function showIntent(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, OPTIONS.show, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  if (!parsed || ref === undefined) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const intent = await client.get(`/v1/intents/${segment(ref)}`, intentDetailSchema);
    if (json) ctx.stdout(toJson(intent));
    else printDetail(ctx, intent);
    return EXIT.ok;
  });
}

function printDetail(ctx: CliContext, intent: IntentDetail): void {
  say(ctx, 'cli.intent.detail', {
    ...summary(intent),
    title: intent.title,
    gate: show(intent.current_gate),
    issue: show(intent.issue_number),
    pr: show(intent.pr_number),
    created_at: intent.created_at,
  });
  if (intent.spec) {
    say(ctx, 'cli.intent.spec', {
      version: intent.spec.version,
      path: intent.spec.path,
      commit: intent.spec.commit_sha,
      sha256: intent.spec.content_sha256,
    });
  } else {
    say(ctx, 'cli.intent.spec_none');
  }
  if (intent.plan) {
    say(ctx, 'cli.intent.plan', {
      version: intent.plan.version,
      sha256: intent.plan.plan_sha256,
      flags: intent.plan.change_flags.join(',') || '-',
    });
  } else {
    say(ctx, 'cli.intent.plan_none');
  }
  if (intent.decisions.length === 0) say(ctx, 'cli.intent.decisions_none');
  for (const decision of intent.decisions)
    say(ctx, 'cli.intent.decision', decisionParams(decision));
}

export function decisionParams(decision: DecisionView): Record<string, string> {
  return {
    gate: decision.gate,
    decision: decision.decision,
    mode: decision.oversight_mode,
    role: show(decision.approver_role),
    actor: decision.actor_type,
    reason: show(decision.reason_code),
    at: decision.created_at,
    expires: show(decision.expires_at),
  };
}

function summary(intent: IntentView): Record<string, string> {
  return {
    code: intent.code,
    project: intent.project.slug,
    status: intent.status,
    risk: intent.risk_tier,
    data_class: intent.data_class,
    max_autonomy: intent.max_autonomy,
    budget: intent.budget_usd,
  };
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.intent.usage'));
  return EXIT.usage;
}
