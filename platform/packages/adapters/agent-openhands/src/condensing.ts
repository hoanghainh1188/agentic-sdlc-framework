// Context condensing (D-08 X11, design/ADR-M29 §2.10, QUESTIONS #551–#554). Agent Server 1.48.0
// takes one condenser per conversation (`agent.condenser`). The platform uses only the
// `LLMSummarizingCondenser`, on the run's own model, LiteLLM URL and virtual key: its calls carry the
// key's seven labels, count against the run's budget and use a model in `allowed_models`.
//
// The condenser writes three kinds of events into the agent's log. They are not agent steps and not
// progress for loop detection. `Condensation` and `CondensationSummaryEvent` hold the summary, which
// is client data: the adapter returns counts only, and the log it hands over holds the summary's
// SHA-256 and length instead of its text (QUESTIONS #551).
import { createHash } from 'node:crypto';

import type { AgentCondensing, AgentLogEvent } from '@sdlc/contracts';

export const CONDENSATION_EVENT = 'Condensation';
const CONDENSATION_REQUEST_EVENT = 'CondensationRequest';
const CONDENSATION_SUMMARY_EVENT = 'CondensationSummaryEvent';
/** ID suffix of a summary in the model's view (`<condensation id>-summary`). */
const SUMMARY_ID_SUFFIX = '-summary';

/** Event kinds the condenser writes. */
export const CONDENSING_EVENTS: ReadonlySet<unknown> = new Set([
  CONDENSATION_EVENT,
  CONDENSATION_REQUEST_EVENT,
  CONDENSATION_SUMMARY_EVENT,
]);

/** Event kinds that may hold a summary. */
const SUMMARY_EVENTS: ReadonlySet<unknown> = new Set([
  CONDENSATION_EVENT,
  CONDENSATION_SUMMARY_EVENT,
]);

/**
 * Share of the model's context the view may fill before a condensation: room is left for the
 * system prompt, the tools and the reply ([Proposal], ADR-M29 §2.10).
 */
export const CONTEXT_SHARE = 0.75;

/** `usage_id` of the condenser's model calls (the agent's are `agent`). */
export const CONDENSER_USAGE_ID = 'condenser';

/** The `agent.condenser` of the conversation request. */
export function condenserOf(
  condensing: AgentCondensing,
  llm: { readonly model: string; readonly baseUrl: string; readonly virtualKey: string },
): Record<string, unknown> {
  return {
    kind: 'LLMSummarizingCondenser',
    llm: {
      model: llm.model,
      base_url: llm.baseUrl,
      api_key: llm.virtualKey,
      usage_id: CONDENSER_USAGE_ID,
    },
    max_size: condensing.maxEvents,
    keep_first: condensing.keepFirst,
    max_tokens: Math.floor(condensing.contextTokens * CONTEXT_SHARE),
  };
}

/** Condensations and the events they removed from the model's view. Counts only. */
export function condensingCounts(events: readonly AgentLogEvent[]): {
  readonly condensations: number;
  readonly eventsForgotten: number;
} {
  let condensations = 0;
  let eventsForgotten = 0;
  for (const event of events) {
    if (event.kind !== CONDENSATION_EVENT) continue;
    condensations += 1;
    // A later condensation also forgets the summary of the one before (`<id>-summary`), which is in
    // the model's view only (found on Agent Server 1.48.0): not an event of the log.
    const forgotten = event.forgotten_event_ids;
    if (Array.isArray(forgotten)) {
      eventsForgotten += forgotten.filter(
        (id) => typeof id !== 'string' || !id.endsWith(SUMMARY_ID_SUFFIX),
      ).length;
    }
  }
  return { condensations, eventsForgotten };
}

/** Events that show the agent's progress: every event but the condenser's. */
export function progressEvents(events: readonly AgentLogEvent[]): number {
  return events.filter((event) => !CONDENSING_EVENTS.has(event.kind)).length;
}

/**
 * The log without summary text: a summary becomes its SHA-256 and its length in characters
 * (`summary_sha256`, `summary_chars`); a missing or empty summary stays `null`. Other events are
 * returned as they are.
 */
export function withoutSummaries(events: readonly AgentLogEvent[]): AgentLogEvent[] {
  return events.map((event) => {
    if (!SUMMARY_EVENTS.has(event.kind) || !Object.hasOwn(event, 'summary')) return event;
    const summary = event.summary;
    if (typeof summary !== 'string' || summary === '') return { ...event, summary: null };
    return {
      ...event,
      summary: null,
      summary_sha256: createHash('sha256').update(summary, 'utf8').digest('hex'),
      summary_chars: summary.length,
    };
  });
}
