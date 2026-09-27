// B07 (ADR-M30): the Temporal client of the intent workflow. Signal-with-start with IDs only; a
// concurrent start by another process falls back to a plain signal. Names shared with the worker.
import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import { describe, expect, it } from 'vitest';

import {
  INTENT_TASK_QUEUE,
  INTENT_WAKE_SIGNAL,
  INTENT_WORKFLOW_TYPE,
  intentWorkflowId,
} from '../../packages/contracts/src/intent-workflow.js';
import {
  NO_INTENT_SIGNALS,
  TEMPORAL_ADDRESS,
  TemporalIntentSignals,
} from '../../packages/workflow-client/src/index.js';

const REF = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  intentId: '00000000-0000-4000-8000-000000000002',
};

function fakeClient(startError?: Error) {
  const calls: { kind: string; args: unknown[] }[] = [];
  const client = {
    workflow: {
      signalWithStart: (...args: unknown[]) => {
        calls.push({ kind: 'signalWithStart', args });
        return startError ? Promise.reject(startError) : Promise.resolve({});
      },
      getHandle: (id: string) => ({
        signal: (name: string) => {
          calls.push({ kind: 'signal', args: [id, name] });
          return Promise.resolve();
        },
      }),
    },
  } as unknown as Client;
  return { client, calls };
}

describe('B07: intent workflow names and client', () => {
  it('workflow IDs hold the tenant and intent UUIDs only', () => {
    expect(intentWorkflowId(REF)).toBe(`intent/${REF.tenantId}/${REF.intentId}`);
    expect(() => intentWorkflowId({ ...REF, intentId: 'INT-2026-0001' })).toThrow();
    expect(INTENT_TASK_QUEUE).toBe('sdlc-intents');
  });

  it('wakes with signal-with-start: IDs as input, a signal without data', async () => {
    const { client, calls } = fakeClient();
    await new TemporalIntentSignals(client).wake(REF);
    expect(calls).toEqual([
      {
        kind: 'signalWithStart',
        args: [
          INTENT_WORKFLOW_TYPE,
          {
            workflowId: intentWorkflowId(REF),
            taskQueue: INTENT_TASK_QUEUE,
            args: [REF],
            signal: INTENT_WAKE_SIGNAL,
            signalArgs: [],
          },
        ],
      },
    ]);
  });

  it('falls back to a plain signal when another process just started the workflow', async () => {
    const started = new WorkflowExecutionAlreadyStartedError('started', 'id', 'intentWorkflow');
    const { client, calls } = fakeClient(started);
    await new TemporalIntentSignals(client).wake(REF);
    expect(calls.map((c) => c.kind)).toEqual(['signalWithStart', 'signal']);
    expect(calls[1]!.args).toEqual([intentWorkflowId(REF), INTENT_WAKE_SIGNAL]);
  });

  it('other errors reach the caller (it logs and relies on the reconcile loop)', async () => {
    const { client } = fakeClient(new Error('unavailable'));
    await expect(new TemporalIntentSignals(client).wake(REF)).rejects.toThrow('unavailable');
    await expect(NO_INTENT_SIGNALS.wake(REF)).resolves.toBeUndefined();
  });

  it('accepts host:port addresses only', () => {
    expect(TEMPORAL_ADDRESS.test('temporal:7233')).toBe(true);
    expect(TEMPORAL_ADDRESS.test('http://temporal:7233')).toBe(false);
    expect(TEMPORAL_ADDRESS.test('temporal')).toBe(false);
  });
});
