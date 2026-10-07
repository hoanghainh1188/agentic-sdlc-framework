// The API reads of the dashboard: GET endpoints that already exist for the CLI (ADR-M54 §2.1).
import {
  chainSchema,
  costReportSchema,
  escalationListSchema,
  evidenceFileSchema,
  evidenceListSchema,
  gateMetricsSchema,
  intentDetailSchema,
  intentPageSchema,
  meSchema,
  runListSchema,
  type EscalationView,
  type IntentView,
} from '@sdlc/api-schemas';

import { apiPath, getJson, segment } from './client.js';

type Signal = { readonly signal?: AbortSignal };

/** At most this many intents on the board (10 pages of the API's maximum, 100). */
export const MAX_BOARD_INTENTS = 1000;

export const readMe = (token?: string, o: Signal = {}) =>
  getJson(apiPath('/v1/me'), meSchema, { ...o, ...(token ? { token } : {}) });

/** Every intent the person can read, page by page; `truncated` past the cap. */
export async function readIntents(
  project: string | undefined,
  o: Signal = {},
): Promise<{ items: IntentView[]; truncated: boolean }> {
  const items: IntentView[] = [];
  let cursor: string | undefined;
  do {
    const page = await getJson(
      apiPath('/v1/intents', { project, limit: 100, cursor }),
      intentPageSchema,
      o,
    );
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined && items.length < MAX_BOARD_INTENTS);
  return { items, truncated: cursor !== undefined };
}

export const readIntent = (code: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/intents/${segment(code)}`), intentDetailSchema, o);

export const readRuns = (code: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/intents/${segment(code)}/runs`), runListSchema, o);

export const readPacks = (code: string, o: Signal = {}) =>
  getJson(apiPath(`/v1/intents/${segment(code)}/evidence-packs`), evidenceListSchema, o);

export const readPackFile = (
  code: string,
  version: number,
  file: 'manifest' | 'markdown',
  o: Signal = {},
) =>
  getJson(
    apiPath(`/v1/intents/${segment(code)}/evidence-packs/${segment(version)}/${file}`),
    evidenceFileSchema,
    o,
  );

/** Open and acknowledged escalations (the API filters one status at a time, at most 100 each). */
export async function readOpenEscalations(
  intent: string | undefined,
  o: Signal = {},
): Promise<{ items: EscalationView[]; truncated: boolean }> {
  const pages = await Promise.all(
    (['open', 'acknowledged'] as const).map((status) =>
      getJson(apiPath('/v1/escalations', { status, intent, limit: 100 }), escalationListSchema, o),
    ),
  );
  return {
    items: pages.flatMap((p) => p.items),
    truncated: pages.some((p) => p.items.length >= 100),
  };
}

export const readCost = (
  query: { project?: string; by?: string; from?: string; to?: string },
  o: Signal = {},
) => getJson(apiPath('/v1/cost/report', query), costReportSchema, o);

export const readGateMetrics = (
  query: { project?: string; from?: string; to?: string },
  o: Signal = {},
) => getJson(apiPath('/v1/metrics/gates', query), gateMetricsSchema, o);

export const readAuditCheck = (o: Signal = {}) =>
  getJson(apiPath('/v1/admin/audit/verify'), chainSchema, o);
