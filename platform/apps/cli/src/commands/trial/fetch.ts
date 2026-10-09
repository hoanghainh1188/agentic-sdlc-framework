// Step 1 of `sdlc trial report` (task V01, ADR-M65 §2.2): reads the API with the existing GET
// endpoints only. The answers are raw: they hold slugs, codes, titles and IDs, and never leave
// this process; `build.ts` copies only the allowed fields out of them.
//
// Limits: at most `POOL_SIZE` requests at a time; a 429, a 5xx, a network error or a timeout is
// tried again `RETRIES` times; a request that still fails stops the whole report (never a report
// with parts missing). At most `maxIntents` intents, the oldest first; the rest is counted as cut.
import type { z } from 'zod';

import {
  costReportSchema,
  escalationListSchema,
  gateMetricsSchema,
  intentDetailSchema,
  intentPageSchema,
  runListSchema,
  type CostReportView,
  type EscalationView,
  type GateMetricsView,
  type IntentDetail,
  type IntentView,
  type RunView,
} from '../../api/schemas.js';
import { ApiCallError, type ApiClient } from '../../api/client.js';
import { segment } from '../../api/session.js';

export const POOL_SIZE = 4;
export const RETRIES = 2;
export const RETRY_DELAYS_MS = [500, 1500] as const;
export const DEFAULT_MAX_INTENTS = 500;
export const MAX_MAX_INTENTS = 1000;
/** Intent list pages read at most (100 intents each). */
export const MAX_INTENT_PAGES = 50;
const INTENT_PAGE = 100;
/** Escalations read per intent (the API's page maximum). */
export const ESCALATIONS_PER_INTENT = 100;

export interface TrialRange {
  /** `YYYY-MM-DD`, included. */
  readonly from: string;
  /** `YYYY-MM-DD`, excluded. */
  readonly to: string;
}

export interface FetchOptions {
  readonly project?: string;
  readonly range: TrialRange;
  readonly maxIntents: number;
  /** Waits between tries (tests pass a fast one). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface IntentData {
  readonly intent: IntentView;
  readonly detail: IntentDetail;
  readonly runs: readonly RunView[];
  readonly escalations: readonly EscalationView[];
}

export interface TrialData {
  readonly metrics: GateMetricsView;
  readonly costByIntent: CostReportView;
  readonly costByModel: CostReportView;
  /** The chosen intents, the oldest first. */
  readonly intents: readonly IntentData[];
  readonly truncated: {
    /** More intents in the range than `maxIntents`, or more than the pages read. */
    readonly intents: boolean;
    /** Intents that reached `ESCALATIONS_PER_INTENT` escalations. */
    readonly escalations: boolean;
  };
}

const sleepReal = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown to the requests still running once another one failed: the report is already lost. */
export class TrialHalted extends Error {
  constructor() {
    super('trial_halted');
  }
}

/**
 * Whether a failed call is worth trying again: a network error, a timeout, a 429, or any answer
 * with a 5xx status (also a proxy's HTML page, which the client reports as malformed).
 */
export function retryable(error: unknown): boolean {
  if (!(error instanceof ApiCallError)) return false;
  if (error.kind === 'network' || error.kind === 'timeout') return true;
  if (error.kind === 'redirect' || error.status === undefined) return false;
  return error.status === 429 || error.status >= 500;
}

export async function fetchTrialData(client: ApiClient, options: FetchOptions): Promise<TrialData> {
  const sleep = options.sleep ?? sleepReal;
  // Set by the first failure: the other workers send no further request (ADR-M65 §2.2).
  const halt = { failed: false };
  const get: Get = (path, schema, query) =>
    withRetry(() => client.get(path, schema, query), sleep, halt);

  const { from, to } = options.range;
  const project = options.project;
  const metrics = (await get('/v1/metrics/gates', gateMetricsSchema, { project, from, to }))
    .metrics;
  const costByIntent = (
    await get('/v1/cost/report', costReportSchema, { project, from, to, by: 'intent' })
  ).report;
  const costByModel = (
    await get('/v1/cost/report', costReportSchema, { project, from, to, by: 'model' })
  ).report;

  const listed = await listIntents(get, project);
  const inRange = listed.items
    .filter(
      (intent) => intent.created_at >= `${from}T00:00:00` && intent.created_at < `${to}T00:00:00`,
    )
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const chosen = inRange.slice(0, options.maxIntents);

  const intents = await pool(chosen, POOL_SIZE, halt, async (intent) => {
    const ref = segment(intent.code);
    // One request at a time per intent, so never more than `POOL_SIZE` in flight.
    const detail = await get(`/v1/intents/${ref}`, intentDetailSchema);
    const runs = await get(`/v1/intents/${ref}/runs`, runListSchema);
    const escalations = await get('/v1/escalations', escalationListSchema, {
      intent: intent.code,
      limit: String(ESCALATIONS_PER_INTENT),
    });
    return { intent, detail, runs: runs.items, escalations: escalations.items };
  });

  return {
    metrics,
    costByIntent,
    costByModel,
    intents,
    truncated: {
      intents: listed.cut || inRange.length > chosen.length,
      escalations: intents.some((i) => i.escalations.length >= ESCALATIONS_PER_INTENT),
    },
  };
}

type Get = <T>(
  path: string,
  schema: z.ZodType<T>,
  query?: Record<string, string | undefined>,
) => Promise<T>;

async function listIntents(
  get: Get,
  project: string | undefined,
): Promise<{ items: IntentView[]; cut: boolean }> {
  const items: IntentView[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_INTENT_PAGES; page += 1) {
    const body = await get('/v1/intents', intentPageSchema, {
      project,
      limit: String(INTENT_PAGE),
      cursor,
    });
    items.push(...body.items);
    if (body.next_cursor === null) return { items, cut: false };
    cursor = body.next_cursor;
  }
  return { items, cut: true };
}

async function withRetry<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  halt: { readonly failed: boolean },
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    if (halt.failed) throw new TrialHalted();
    try {
      return await call();
    } catch (error) {
      if (attempt >= RETRIES || !retryable(error)) throw error;
      await sleep(RETRY_DELAYS_MS[attempt] ?? 1500);
    }
  }
}

/** Runs `work` for every item, at most `size` at a time; keeps the order; the first failure wins. */
export async function pool<I, O>(
  items: readonly I[],
  size: number,
  halt: { failed: boolean },
  work: (item: I) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  let first: unknown;
  const worker = async (): Promise<void> => {
    while (!halt.failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index] as I);
      } catch (error) {
        if (!halt.failed) first = error;
        halt.failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  if (halt.failed) throw first;
  return results;
}
