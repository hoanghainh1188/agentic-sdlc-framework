// Temporal client for the intent workflow (task B07, design/ADR-M30). The api and the worker use
// it to wake an intent's workflow after they record something the workflow must see (an intent
// created, a gate decision, an escalation acknowledged or decided). Core never imports Temporal.
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import {
  INTENT_TASK_QUEUE,
  INTENT_WAKE_SIGNAL,
  INTENT_WORKFLOW_TYPE,
  intentWorkflowId,
  type IntentWorkflowRef,
  type IntentWorkflowSignals,
} from '@sdlc/contracts';

/** Where the Temporal frontend is. Technical settings of each process, not project config. */
export interface TemporalSettings {
  /** `host:port` of the frontend, for example `temporal:7233`. */
  readonly address: string;
  readonly namespace: string;
}

/** `host:port`, host = letters, digits, dots and hyphens. */
export const TEMPORAL_ADDRESS = /^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/;
/** Temporal namespace names: letters, digits, dots, hyphens and underscores. */
export const TEMPORAL_NAMESPACE = /^[A-Za-z0-9._-]{1,200}$/;

export interface TemporalClient {
  readonly client: Client;
  readonly connection: Connection;
  close(): Promise<void>;
}

/**
 * Connects to the Temporal frontend. The MVP runs it on the internal Compose network without TLS,
 * like PostgreSQL (ADR-M30 §2.1).
 */
export async function connectTemporal(settings: TemporalSettings): Promise<TemporalClient> {
  const connection = await Connection.connect({ address: settings.address });
  const client = new Client({ connection, namespace: settings.namespace });
  return { client, connection, close: () => connection.close() };
}

/**
 * Wakes intent workflows with signal-with-start: a workflow that does not run yet is started, a
 * running one gets the signal. The signal carries no data, so repeating it is harmless.
 */
export class TemporalIntentSignals implements IntentWorkflowSignals {
  constructor(private readonly client: Client) {}

  async wake(ref: IntentWorkflowRef): Promise<void> {
    const workflowId = intentWorkflowId(ref);
    try {
      await this.client.workflow.signalWithStart(INTENT_WORKFLOW_TYPE, {
        workflowId,
        taskQueue: INTENT_TASK_QUEUE,
        args: [{ tenantId: ref.tenantId, intentId: ref.intentId }],
        signal: INTENT_WAKE_SIGNAL,
        signalArgs: [],
      });
    } catch (error) {
      // Two processes woke a new intent at the same moment and the other one started it: the
      // workflow runs, so a plain signal is enough.
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      await this.client.workflow.getHandle(workflowId).signal(INTENT_WAKE_SIGNAL);
    }
  }
}

/** Signals that do nothing: a process running without Temporal (dev mode, tests). */
export const NO_INTENT_SIGNALS: IntentWorkflowSignals = {
  wake: () => Promise.resolve(),
};
