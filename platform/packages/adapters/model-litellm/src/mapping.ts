// Pure mapping between the ModelGateway contract and the LiteLLM Proxy API (v1.102.1, checked live
// in design/ADR-M24 §2.2). Kept free of I/O so the unit tests can check caps, labels and parsing.
import {
  COST_LABEL_NAMES,
  COST_LABEL_VALUE,
  PROVIDER_TYPES,
  type CostLabelName,
  type CostLabels,
  type CreateRunKey,
  type ModelRef,
  type ProviderType,
  type SpendRecord,
} from '@sdlc/contracts';

import { GatewayError } from './errors.js';

const USD = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Longest key lifetime we ask for: a run never needs more than a day (FR-32 time cap). */
const MAX_KEY_MINUTES = 24 * 60;

/** The tenant's LiteLLM team has a fixed ID, so it is found without a lookup. */
export function tenantTeamId(tenantSlug: string): string {
  if (!SLUG.test(tenantSlug)) {
    throw new GatewayError('invalid_input', 'tenant slug is not valid', undefined, 'tenantSlug');
  }
  return `sdlc-tenant-${tenantSlug}`;
}

/** The key alias names the run, so spend rows can be traced back even without labels. */
export function runKeyAlias(runId: string): string {
  return `run-${runId}`;
}

/**
 * Labels as LiteLLM tags (`<label>:<value>`). LiteLLM copies the key's `metadata.tags` onto every
 * spend row (`request_tags`); the key's other metadata is not copied (ADR-M24 §2.2).
 */
export function labelTags(labels: CostLabels): string[] {
  return COST_LABEL_NAMES.map((name) => `${name}:${labels[name]}`);
}

/** Reads our labels back from `request_tags`. Other tags (LiteLLM adds `User-Agent: …`) are ignored. */
export function labelsFromTags(tags: unknown): Partial<CostLabels> {
  const labels: Partial<Record<CostLabelName, string>> = {};
  if (!Array.isArray(tags)) return labels;
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const colon = tag.indexOf(':');
    const name = tag.slice(0, colon) as CostLabelName;
    const value = tag.slice(colon + 1);
    if (colon > 0 && COST_LABEL_NAMES.includes(name) && COST_LABEL_VALUE.test(value)) {
      labels[name] = value;
    }
  }
  return labels;
}

function usdToNumber(value: string, field: string): number {
  if (!USD.test(value))
    throw new GatewayError('invalid_input', `${field} is not USD`, undefined, field);
  return Number(value);
}

/** LiteLLM reports spend as a float; we keep 6 decimals (numeric(18,6), D-05 D6). */
export function usdFromNumber(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0)
    throw new GatewayError('unexpected_response', 'spend is not a number');
  const micros = BigInt(Math.round(n * 1_000_000));
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** Body of `POST /key/generate`. */
export function keyGenerateBody(input: CreateRunKey): Record<string, unknown> {
  if (!UUID.test(input.runId))
    throw new GatewayError('invalid_input', 'runId is not a UUID', undefined, 'runId');
  if (input.labels.run_id !== input.runId) {
    throw new GatewayError('invalid_input', 'label run_id differs from runId', undefined, 'labels');
  }
  for (const name of COST_LABEL_NAMES) {
    if (!COST_LABEL_VALUE.test(input.labels[name] ?? '')) {
      throw new GatewayError('invalid_input', `label ${name} is not a code`, undefined, 'labels');
    }
  }
  const budget = usdToNumber(input.maxBudgetUsd, 'maxBudgetUsd');
  if (budget <= 0)
    throw new GatewayError(
      'invalid_input',
      'maxBudgetUsd must be above 0',
      undefined,
      'maxBudgetUsd',
    );
  if (input.models.length === 0 || !input.models.every((m) => MODEL.test(m))) {
    throw new GatewayError(
      'invalid_input',
      'models must be a non-empty list of model names',
      undefined,
      'models',
    );
  }
  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < 1 ||
    input.durationMinutes > MAX_KEY_MINUTES
  ) {
    throw new GatewayError(
      'invalid_input',
      'durationMinutes is out of range',
      undefined,
      'durationMinutes',
    );
  }
  return {
    key_alias: runKeyAlias(input.runId),
    team_id: input.tenantGroupId,
    models: [...input.models],
    max_budget: budget,
    duration: `${input.durationMinutes}m`,
    metadata: { ...input.labels, tags: labelTags(input.labels) },
  };
}

/** Body of `POST /team/new` and `POST /team/update`. The budget resets each UTC calendar month. */
export function teamBody(teamId: string, monthlyBudgetUsd: string | null): Record<string, unknown> {
  return {
    team_id: teamId,
    team_alias: teamId,
    max_budget:
      monthlyBudgetUsd === null ? null : usdToNumber(monthlyBudgetUsd, 'monthlyBudgetUsd'),
    budget_duration: '1mo',
  };
}

function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value);
}

/**
 * Models from `GET /model/info`. Each model must declare `model_info.provider_type` (`api` or
 * `self_hosted`, D-07 section 4); a model without it is left out, so policy never routes to it.
 */
export function modelsFromInfo(body: unknown): ModelRef[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data))
    throw new GatewayError('unexpected_response', '/model/info has no data list');
  const seen = new Map<string, ProviderType>();
  for (const entry of data as {
    model_name?: unknown;
    model_info?: { provider_type?: unknown };
  }[]) {
    const model = entry?.model_name;
    const providerType = entry?.model_info?.provider_type;
    if (typeof model === 'string' && MODEL.test(model) && isProviderType(providerType)) {
      seen.set(model, providerType);
    }
  }
  return [...seen].map(([model, providerType]) => ({ model, providerType }));
}

function tokenCount(value: unknown): number {
  const n = typeof value === 'number' ? value : 0;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

interface SpendRow {
  request_id?: unknown;
  model?: unknown;
  model_group?: unknown;
  status?: unknown;
  spend?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  startTime?: unknown;
  request_tags?: unknown;
  metadata?: { usage_object?: { prompt_tokens_details?: { cached_tokens?: unknown } } };
}

/** One row of `GET /spend/logs/v2`. */
export function spendRecordFromRow(row: SpendRow): SpendRecord {
  const sourceRef = row.request_id;
  // `model_group` is the name the caller asked for (the name in allowed_models); `model` is the
  // provider model behind it. Failed calls may have an empty group.
  const group =
    typeof row.model_group === 'string' && row.model_group !== '' ? row.model_group : row.model;
  const started = typeof row.startTime === 'string' ? new Date(row.startTime) : undefined;
  if (
    typeof sourceRef !== 'string' ||
    typeof group !== 'string' ||
    !started ||
    Number.isNaN(started.getTime())
  ) {
    throw new GatewayError(
      'unexpected_response',
      'spend row misses request_id, model or startTime',
    );
  }
  const inputTokens = tokenCount(row.prompt_tokens);
  const cached = tokenCount(row.metadata?.usage_object?.prompt_tokens_details?.cached_tokens);
  return {
    sourceRef,
    model: group,
    status: row.status === 'success' ? 'success' : 'failure',
    inputTokens,
    outputTokens: tokenCount(row.completion_tokens),
    cachedInputTokens: Math.min(cached, inputTokens),
    costUsd: usdFromNumber(row.spend),
    occurredAt: started,
    labels: labelsFromTags(row.request_tags),
  };
}

/** LiteLLM's spend log filter takes `YYYY-MM-DD HH:MM:SS` in UTC. */
export function spendLogTime(at: Date): string {
  return at.toISOString().slice(0, 19).replace('T', ' ');
}
