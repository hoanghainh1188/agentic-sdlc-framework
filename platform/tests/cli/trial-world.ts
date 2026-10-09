// A mocked API for `sdlc trial report` (task V01, ADR-M65): every answer is built with the API's
// own presenters, so the mock cannot drift from the real API. The world holds slugs, intent codes,
// titles, UUIDs, an e-mail and a repository on purpose: none of them may reach the report.
import { presentCostReport } from '../../apps/api/src/cost/present.js';
import { presentDecision, presentIntent } from '../../apps/api/src/intents/present.js';
import { presentGateMetrics } from '../../apps/api/src/metrics/present.js';
import { presentRunList } from '../../apps/api/src/runs/present.js';
import {
  costReportSchema,
  escalationListSchema,
  gateMetricsSchema,
  intentDetailSchema,
  intentPageSchema,
  runListSchema,
} from '../../apps/cli/src/api/schemas.js';
import type { Escalation, GateDecisionRow, Run } from '../../packages/core/src/index.js';
import { decisionRow, escalationBody, intentRow, runRow, TENANT, USER } from './fixtures.js';

export const SECRET_SLUG = 'acme-secret-shop';
export const SECRET_REPO = 'acme-corp/secret-shop';
export const SECRET_EMAIL = 'someone@acme.example';
export const NOW = new Date('2026-10-09T12:00:00.000Z');

const PROJECT = {
  id: '33333333-3333-4333-8333-333333333333',
  slug: SECRET_SLUG,
  repo_full_name: SECRET_REPO,
};

export interface WorldOptions {
  /** How many intents in the range (default 2). */
  readonly intents?: number;
  /** One more intent created before the range. */
  readonly old?: boolean;
}

export interface Reply {
  readonly status: number;
  readonly body?: unknown;
  /** A body that is not JSON (a proxy's error page). */
  readonly raw?: string;
}

const iso = (ms: number): Date => new Date(ms);
const code = (n: number): string => `INT-2026-${String(n).padStart(4, '0')}`;
const uuid = (n: number): string => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

/** The answers of the API, by path (and `by` for the cost report). */
export class TrialWorld {
  readonly intents: Record<string, unknown>[] = [];
  readonly details = new Map<string, Record<string, unknown>>();
  readonly runs = new Map<string, Record<string, unknown>>();
  readonly escalations = new Map<string, Record<string, unknown>>();
  metrics: Record<string, unknown>;
  costByIntent: Record<string, unknown>;
  costByModel: Record<string, unknown>;

  constructor(options: WorldOptions = {}) {
    const count = options.intents ?? 2;
    const first = Date.parse('2026-09-01T00:00:00.000Z');
    for (let n = 1; n <= count; n += 1) this.addIntent(n, iso(first + n * 60_000), n === 1);
    if (options.old) this.addIntent(9000, new Date('2026-01-02T00:00:00.000Z'), false);
    this.metrics = presentGateMetrics({
      scope: { kind: 'tenant' },
      from: new Date('2026-07-11T00:00:00.000Z'),
      to: new Date('2026-10-10T00:00:00.000Z'),
      asOf: NOW,
      filters: { gate: null, mode: null, riskTier: null },
      rows: [
        {
          project: SECRET_SLUG,
          gate: 'G3',
          firstRound: {
            count: 2,
            avgSeconds: 5400,
            maxSeconds: 9000,
            p50Seconds: 3600,
            p90Seconds: 9000,
          },
          afterChanges: {
            count: 0,
            avgSeconds: null,
            maxSeconds: null,
            p50Seconds: null,
            p90Seconds: null,
          },
          autoPassed: 1,
          open: { count: 1, oldestSeconds: 120 },
        },
      ],
      truncated: false,
    });
    const cost = {
      calls: 3,
      inputTokens: '1200',
      outputTokens: '300',
      cachedInputTokens: '100',
      costUsd: '0.300000',
      wastedTokens: '500',
      wastedCostUsd: '0.100000',
    };
    const range = {
      from: new Date('2026-07-11T00:00:00.000Z'),
      to: new Date('2026-10-10T00:00:00.000Z'),
    };
    const freshness = { latestCallAt: NOW, lastRecordedAt: NOW, runsInProgress: 0 };
    this.costByIntent = presentCostReport({
      scope: { kind: 'tenant' },
      ...range,
      groupBy: 'intent',
      totals: cost,
      rows: [{ key: code(1), ...cost }],
      truncated: false,
      freshness,
    });
    this.costByModel = presentCostReport({
      scope: { kind: 'tenant' },
      ...range,
      groupBy: 'model',
      totals: { ...cost, calls: 4, costUsd: '0.400001' },
      rows: [
        { key: 'gpt-oss-20b', ...cost },
        { key: 'Weird Model/X', ...cost, calls: 1, costUsd: '0.100001' },
        { key: 'Another Odd', ...cost, calls: 2, costUsd: '0.999999' },
      ],
      truncated: false,
      freshness,
    });
  }

  private addIntent(n: number, created: Date, finished: boolean): void {
    const id = uuid(n);
    const row = intentRow({
      id,
      code: code(n),
      title: `Secret title ${String(n)}`,
      description: `Secret description ${String(n)}`,
      status: finished ? 'done' : 'in_gate',
      current_gate: finished ? null : 'G4',
      gate_entered_at: finished ? null : created,
      waiting_reason: null,
      waiting_since: null,
      created_at: created,
      updated_at: new Date(created.getTime() + 3_600_000),
    });
    const body = presentIntent(row, PROJECT);
    this.intents.unshift(body as unknown as Record<string, unknown>);
    const decisions: GateDecisionRow[] = [
      decisionRow({ intent_id: id, gate: 'G1', decision: 'approve' }),
      decisionRow({
        intent_id: id,
        gate: 'G2',
        decision: 'pass',
        actor_type: 'system',
        decided_by: null,
        approver_role: null,
        oversight_mode: 'HOTL',
      }),
      decisionRow({
        intent_id: id,
        gate: 'G7',
        decision: 'request_changes',
        reason_code: 'other',
        reason_ref: 'https://github.com/acme-corp/secret-shop/pull/1#c',
      }),
      decisionRow({ intent_id: id, gate: 'G7', decision: 'approve', source: 'github_review' }),
    ];
    this.details.set(code(n), {
      ...body,
      waiting_for: null,
      spec: null,
      plan: null,
      decisions: decisions.map((d) => presentDecision(d)),
    });
    const runs: Run[] = [
      runRow({
        id: `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`,
        intent_id: id,
        attempt: 1,
        status: 'failed',
        stop_reason: 'agent_error',
        finished_at: created,
      }),
      runRow({
        id: `77777777-7777-4777-8778-${String(n).padStart(12, '0')}`,
        intent_id: id,
        attempt: 2,
        status: 'succeeded',
        stop_reason: null,
        finished_at: created,
      }),
    ];
    this.runs.set(code(n), presentRunList(code(n), runs));
    const esc: Partial<Escalation> = {
      intent_id: id,
      trigger: 'time',
      route: 'intent',
      severity: 'medium',
      status: 'open',
    };
    this.escalations.set(code(n), {
      items: n === 1 ? [escalationOf(code(n), id, esc)] : [],
    });
  }

  /** The answer of one GET request. */
  reply(url: URL): Reply {
    const path = url.pathname;
    if (path === '/v1/metrics/gates') return { status: 200, body: this.metrics };
    if (path === '/v1/cost/report') {
      return {
        status: 200,
        body: url.searchParams.get('by') === 'model' ? this.costByModel : this.costByIntent,
      };
    }
    if (path === '/v1/intents') {
      const start = Number(url.searchParams.get('cursor') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const items = this.intents.slice(start, start + limit);
      const next = start + limit < this.intents.length ? String(start + limit) : null;
      return { status: 200, body: { items, next_cursor: next } };
    }
    if (path === '/v1/escalations') {
      const body = this.escalations.get(url.searchParams.get('intent') ?? '');
      return body
        ? { status: 200, body }
        : { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
    }
    const runs = /^\/v1\/intents\/([^/]+)\/runs$/.exec(path);
    if (runs) {
      const body = this.runs.get(decodeURIComponent(runs[1] ?? ''));
      if (body) return { status: 200, body };
    }
    const detail = /^\/v1\/intents\/([^/]+)$/.exec(path);
    if (detail) {
      const body = this.details.get(decodeURIComponent(detail[1] ?? ''));
      if (body) return { status: 200, body };
    }
    return { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
  }
}

function escalationOf(
  intentCode: string,
  intentId: string,
  overrides: Partial<Escalation>,
): unknown {
  const body = escalationBody(overrides);
  return { ...body, intent: { id: intentId, code: intentCode } };
}

/** The CLI schema of each answer, to keep a changed answer valid (the marker test). */
export interface Checkable {
  safeParse(value: unknown): { success: boolean };
}

export function schemaFor(url: URL): Checkable | undefined {
  const path = url.pathname;
  if (path === '/v1/metrics/gates') return gateMetricsSchema;
  if (path === '/v1/cost/report') return costReportSchema;
  if (path === '/v1/intents') return intentPageSchema;
  if (path === '/v1/escalations') return escalationListSchema;
  if (/^\/v1\/intents\/[^/]+\/runs$/.test(path)) return runListSchema;
  if (/^\/v1\/intents\/[^/]+$/.test(path)) return intentDetailSchema;
  return undefined;
}

export { TENANT, USER };
