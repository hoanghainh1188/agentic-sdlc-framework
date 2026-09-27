// The intent workflow on Temporal (task B07, design/ADR-M30). Names shared by the worker, which
// runs the workflow, and by the processes that wake it (api, poller). Pure constants: the
// workflow code imports this module too, and it must stay deterministic.

/** Temporal task queue of the intent workflow. The runner has its own queue (`sdlc-runner`, C06). */
export const INTENT_TASK_QUEUE = 'sdlc-intents';

/** Workflow type name (the exported workflow function). */
export const INTENT_WORKFLOW_TYPE = 'intentWorkflow';

/**
 * Signal that asks the workflow to read the intent's state again. It carries no data: the
 * database is the source of truth, so a duplicate or replayed signal is harmless.
 */
export const INTENT_WAKE_SIGNAL = 'wake';

/** Input of the workflow and of its activities: IDs only, never client data (ADR-M30). */
export interface IntentWorkflowRef {
  readonly tenantId: string;
  readonly intentId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Workflow ID of an intent: `intent/<tenant_id>/<intent_id>`. Throws for IDs that are not UUIDs. */
export function intentWorkflowId(ref: IntentWorkflowRef): string {
  if (!UUID.test(ref.tenantId) || !UUID.test(ref.intentId)) {
    throw new Error('intentWorkflowId: tenant and intent IDs must be lowercase UUIDs');
  }
  return `intent/${ref.tenantId}/${ref.intentId}`;
}

/**
 * Wakes the workflow of an intent, starting it when it does not run yet (Temporal
 * signal-with-start). Implemented by `@sdlc/workflow-client`; tests pass a fake.
 */
export interface IntentWorkflowSignals {
  wake(ref: IntentWorkflowRef): Promise<void>;
}

/** What one step of the workflow did (the `stepIntent` activity). Codes only. */
export type IntentStepResult =
  /** The intent moved: status or gate changed. The workflow steps again at once. */
  | { readonly outcome: 'moved' }
  /**
   * Nothing to do until something changes; the workflow waits for a wake signal. With `wakeInMs`
   * it also steps again after that delay without a signal (session 2: the gate deadline, the end
   * of a HOTL block window). The delay is relative, so the workflow never compares its own clock
   * with the database's.
   */
  | {
      readonly outcome: 'waiting';
      readonly reason: IntentWaitReason;
      readonly wakeInMs?: number;
    }
  /** The intent is finished (`done`, `rejected`, `cancelled`, `blocked`); the workflow ends. */
  | { readonly outcome: 'finished'; readonly status: string }
  /**
   * C06 session 2 (ADR-M33 §2.6): the intent is `running` and needs a new run. The workflow calls
   * `prepareRun`, then hands the run to the runner (task queue `sdlc-runner`).
   */
  | { readonly outcome: 'run_prepare' }
  /** C06 session 2: the intent's run ended (a final status); the workflow calls `finishRun`. */
  | { readonly outcome: 'run_ended'; readonly runId: string };

export type IntentWaitReason =
  /** The gate needs a person's decision. */
  | 'decision'
  /** The gate's input (spec at G2, plan at G3) does not exist yet. */
  | 'input_missing'
  /**
   * The project AI record is missing or does not allow the intent's data class: the submit waits
   * until the record is fixed (D-02 FR-19, ADR-M32 §2.5).
   */
  | 'ai_record'
  /** An escalation freezes the intent (ADR-M28 §2.4). */
  | 'frozen'
  /**
   * The intent waits at a gate that later tasks handle, or for the end of the last HOTL block
   * window before a run may start (G4, ADR-M30 §2.4b).
   */
  | 'later_gate'
  /**
   * A G4 check failed (task C06, ADR-M33): the agent, its instructions, the AI record, the
   * approved inputs or the budget. A system `fail` records the cause; the next wake checks again.
   */
  | 'g4_check'
  /** G4 passed or was approved; the run starts (C06 session 2 hands it to the runner). */
  | 'run_pending'
  /** The Git host could not be read for the G4 facts (base commit, instructions file). */
  | 'git_host_unavailable'
  /** C06 session 2: the intent's run is under way (the workflow that drives it waits for it). */
  | 'run_in_progress'
  /**
   * C06 session 2: the run failed or was lost and the intent is paused: it waits until the run's
   * escalation lets a new run start (a person decided; ADR-M33 §2.7).
   */
  | 'run_review'
  /**
   * C06 session 2b: the L1 (High risk) run stored its proposal as evidence (QUESTIONS #111); the
   * intent is paused at G4 while Person A takes the proposal forward (no new run starts).
   */
  | 'proposal_review'
  /** A status that the workflow does not move (`paused`, `blocked`, `running`). */
  | 'not_in_gate';
