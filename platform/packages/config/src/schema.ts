// Structural schema of the effective project configuration (design/D-08 A05 AC1).
// Mandatory handbook rules are checked separately, in mandatory-rules.ts.
// Error text never comes from zod: issues are mapped to message keys in `toConfigIssues`.
import {
  AUTONOMY_LEVELS,
  CHANGE_FLAGS,
  OVERSIGHT_MODES,
  PROJECT_ROLES,
  PROVIDER_TYPES,
  RESPONSE_LEVELS,
  SAFE_ACTIONS,
  SEVERITIES,
} from '@sdlc/contracts';
import type { MessageKey } from '@sdlc/messages';
import { z } from 'zod';

import { formatPath, issue, type ConfigIssue } from './issues.js';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_USD_DECIMALS = 6; // design/D-05 principle D6: numeric(18,6)

type RefineContext = z.core.$RefinementCtx;

function addIssue(ctx: RefineContext, key: MessageKey, params: Record<string, string> = {}): void {
  ctx.addIssue({ code: 'custom', input: undefined, params: { key, ...params } });
}

function uniqueList<T extends z.ZodType>(item: T) {
  return z.array(item).superRefine((items, ctx) => {
    const seen = new Set<unknown>();
    for (const value of items) {
      if (seen.has(value)) addIssue(ctx, 'config.schema.duplicate_item', { item: String(value) });
      seen.add(value);
    }
  });
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const usd = z
  .number()
  .positive()
  .superRefine((value, ctx) => {
    const decimals = value.toString().split('.')[1]?.length ?? 0;
    if (decimals > MAX_USD_DECIMALS || value.toString().includes('e')) {
      addIssue(ctx, 'config.schema.too_many_decimals', { maximum: String(MAX_USD_DECIMALS) });
    }
  });

const role = z.enum(PROJECT_ROLES);
const oversightMode = z.enum(OVERSIGHT_MODES);

const cell = z.strictObject({
  mode: z.enum([...OVERSIGHT_MODES, 'POLICY']),
  roles: uniqueList(role).default([]),
  approvals: positiveInt.default(1),
  on_breach: oversightMode.optional(),
});

const tierMatrix = z.strictObject({ low: cell, medium: cell, high: cell, critical: cell });

const duration = z.strictObject({
  value: positiveInt,
  unit: z.enum(['minutes', 'hours', 'days', 'working_hours', 'working_days']),
});

const deadline = z.union([
  duration,
  z.strictObject({ kind: z.literal('end_of_working_day') }),
  z.strictObject({ kind: z.literal('next_planned_work') }),
]);

const hhmm = z.string().superRefine((value, ctx) => {
  if (!HH_MM.test(value)) addIssue(ctx, 'config.schema.invalid_time', { value });
});

const calendar = z.strictObject({
  time_zone: z.string().superRefine((value, ctx) => {
    if (!isValidTimeZone(value)) addIssue(ctx, 'config.schema.invalid_time_zone', { value });
  }),
  working_days: uniqueList(z.enum(WEEKDAYS)).min(1),
  working_hours: z.strictObject({ start: hhmm, end: hhmm }).superRefine((hours, ctx) => {
    if (HH_MM.test(hours.start) && HH_MM.test(hours.end) && hours.start >= hours.end) {
      addIssue(ctx, 'config.schema.working_hours_order', hours);
    }
  }),
  holidays: uniqueList(
    z.string().superRefine((value, ctx) => {
      if (!isValidIsoDate(value)) addIssue(ctx, 'config.schema.invalid_date', { value });
    }),
  ).default([]),
});

const sla = z.strictObject({ acknowledge: duration, resolve: deadline });

const escalationRouting = z.strictObject({ owner_role: role, backup_role: role.nullable() });

const providerList = uniqueList(z.enum(PROVIDER_TYPES));

const autonomyLevel = z.enum(AUTONOMY_LEVELS);

// A container image pinned by digest (QUESTIONS #59, ADR-M25): `[registry/]name[:tag]@sha256:<hex>`.
// A tag alone can move, so it is refused.
const PINNED_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$/;
const pinnedImage = z.string().superRefine((value, ctx) => {
  if (!PINNED_IMAGE.test(value)) addIssue(ctx, 'config.schema.image_not_pinned', { value });
});

export const projectConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  oversight: z.strictObject({
    matrix: z.strictObject({
      G1: tierMatrix,
      G2: tierMatrix,
      G3: tierMatrix,
      G4: tierMatrix,
      G5: tierMatrix,
      G6: tierMatrix,
      G7: tierMatrix,
      G8: z.strictObject({ production: tierMatrix, non_production: tierMatrix }),
    }),
    forced_hitl_g3: z.strictObject({ change_flags: uniqueList(z.enum(CHANGE_FLAGS)) }),
    dual_approval_g7: z.strictObject({
      change_flags: uniqueList(z.enum(CHANGE_FLAGS)),
      roles: uniqueList(role),
    }),
    g6_security_findings: z.strictObject({
      mode: oversightMode,
      min_severity: z.enum(SEVERITIES),
    }),
    hitl_gate_deadline: duration,
    hotl_block_window: duration,
    approval_expiry: duration,
    gate_overdue: z.strictObject({
      severity: z.enum(SEVERITIES),
      response_level: z.enum(RESPONSE_LEVELS),
    }),
  }),
  autonomy: z.strictObject({
    max_by_risk: z.strictObject({
      low: autonomyLevel,
      medium: autonomyLevel,
      high: autonomyLevel,
      critical: autonomyLevel,
    }),
  }),
  escalation: z.strictObject({
    sla: z.strictObject({ critical: sla, high: sla, medium: sla, low: sla }),
    calendar,
    routing: z.strictObject({
      intent: escalationRouting,
      technical: escalationRouting,
      security: escalationRouting,
      policy: escalationRouting,
    }),
    notify_on_raise: z.strictObject({
      critical: uniqueList(role),
      high: uniqueList(role),
      medium: uniqueList(role),
      low: uniqueList(role),
    }),
    reminder_percent: positiveInt.max(99),
    safe_actions: uniqueList(z.enum(SAFE_ACTIONS)),
  }),
  run: z.strictObject({
    g6_ci_retries: nonNegativeInt,
    loop_detection: z.strictObject({
      identical_tool_calls_max: positiveInt,
      no_progress_window_minutes: positiveInt,
    }),
    contract_validity_minutes: positiveInt,
    contract_clock_skew_seconds: nonNegativeInt,
    default_max_iterations: positiveInt,
    default_max_duration_minutes: positiveInt,
  }),
  budget: z.strictObject({
    warn_percent: positiveInt,
    stop_percent: positiveInt,
    default_intent_usd: usd,
    default_run_usd: usd,
  }),
  model_routing: z.strictObject({
    allowed_provider_types: z.strictObject({
      public: providerList,
      internal: providerList,
      client_confidential: providerList,
      client_restricted: providerList,
      prohibited: providerList,
    }),
  }),
  retention: z.strictObject({ evidence_retention_days: positiveInt }),
  github: z.strictObject({ poll_interval_seconds: positiveInt }),
  access: z.strictObject({
    intent_create_roles: uniqueList(role).min(1),
    intent_read_roles: uniqueList(role).min(1),
    ai_record_write_roles: uniqueList(role).min(1),
    ai_record_read_roles: uniqueList(role).min(1),
  }),
  agents: z.strictObject({ recertification_months: positiveInt }),
  sandbox: z.strictObject({ image: pinnedImage }),
});

/** Maps zod issues to catalog-keyed configuration issues. Zod's own English text is never used. */
export function toConfigIssues(zodIssues: readonly z.core.$ZodIssue[]): ConfigIssue[] {
  return zodIssues.flatMap((zodIssue) => fromZodIssue(zodIssue));
}

function fromZodIssue(zodIssue: z.core.$ZodIssue): ConfigIssue[] {
  const path = formatPath(zodIssue.path);
  // With `reportInput`, a missing setting is a type or value issue whose input is undefined.
  const missing = 'input' in zodIssue && zodIssue.input === undefined;
  if (missing && (zodIssue.code === 'invalid_type' || zodIssue.code === 'invalid_value')) {
    return [issue('config.schema.missing', path)];
  }
  switch (zodIssue.code) {
    case 'invalid_type':
      return [issue('config.schema.invalid_type', path, { expected: zodIssue.expected })];
    case 'unrecognized_keys':
      return zodIssue.keys.map((key) => issue('config.schema.unknown_key', path, { key }));
    case 'invalid_value':
      return [
        issue('config.schema.invalid_value', path, {
          allowed: zodIssue.values.map((value) => String(value)).join(', '),
        }),
      ];
    case 'too_small':
      return [
        zodIssue.origin === 'array'
          ? issue('config.schema.too_few_items', path, { minimum: String(zodIssue.minimum) })
          : issue('config.schema.too_small', path, { minimum: String(zodIssue.minimum) }),
      ];
    case 'too_big':
      return [issue('config.schema.too_big', path, { maximum: String(zodIssue.maximum) })];
    case 'custom':
      return [fromCustomIssue(path, zodIssue.params)];
    default:
      return [issue('config.schema.invalid', path)];
  }
}

function fromCustomIssue(path: string, params: Record<string, unknown> | undefined): ConfigIssue {
  const { key, ...rest } = params ?? {};
  if (typeof key !== 'string') return issue('config.schema.invalid', path);
  const values = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]));
  return issue(key as MessageKey, path, values);
}
