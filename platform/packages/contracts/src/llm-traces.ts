// The store of model-call traces (task E08, design/ADR-M53; D-02 FR-44). LiteLLM sends every model
// call to it with the seven labels as tags `<label>:<value>` (ADR-M35 §2.4, ADR-M24 §2.2); the
// traces hold the prompts and responses, so they are client data. The worker's retention loop
// deletes the traces of an intent when its evidence is purged.
//
// - Traces are selected by tag, and every trace comes back with its full tag list: the caller
//   checks the tags of each trace before it asks for the delete.
// - A delete may be asynchronous: the store accepts it at once and removes the data later. The
//   caller confirms on a later pass by selecting again.
// - Errors are codes (`LlmTraceError`); no text from the service leaves the adapter.

export const LLM_TRACE_ERROR_CODES = [
  /** A value the store refuses before any call (a tag, a trace ID, a limit). */
  'invalid_input',
  /** The store refused the credentials. */
  'forbidden',
  /** More traces than the caller's limit: nothing is returned (the per-intent guard). */
  'too_many',
  /** The store could not be reached or answered something unexpected. */
  'unavailable',
] as const;
export type LlmTraceErrorCode = (typeof LLM_TRACE_ERROR_CODES)[number];

/** Why a trace store call failed. A code only: never text from the service. */
export class LlmTraceError extends Error {
  override readonly name = 'LlmTraceError';

  constructor(readonly code: LlmTraceErrorCode) {
    super(`llm_traces.${code}`);
  }
}

/** One trace: its ID and every tag its observations carry. */
export interface LlmTraceRef {
  readonly traceId: string;
  readonly tags: readonly string[];
}

export interface LlmTraceStore {
  /**
   * The store's own ID of the project the credentials belong to. The caller checks it before it
   * trusts an empty selection: a key of another project would find nothing and "confirm" every
   * purge (ADR-M53 §2.3).
   */
  projectId(): Promise<string>;
  /**
   * Every trace that carries at least one of `tags`, with all its tags. Fails `too_many` when
   * there are more than `max` traces: the caller never gets part of a selection as all of it.
   */
  findTraces(input: {
    readonly tags: readonly string[];
    readonly max: number;
  }): Promise<readonly LlmTraceRef[]>;
  /** Asks the store to delete the traces. May return before the data is gone. */
  deleteTraces(traceIds: readonly string[]): Promise<void>;
  /**
   * Removes the rows of deleted traces from disk where the store only hides them at first
   * (ClickHouse lightweight deletes). Returns how long it took.
   */
  compactDeleted(): Promise<{ readonly durationMs: number }>;
}
