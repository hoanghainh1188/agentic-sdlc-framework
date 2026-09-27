// The Temporal worker of the intent workflow (task B07, design/ADR-M30 §2.1). It runs in the
// worker process next to the GitHub poller and the escalation clock loop, on the task queue
// `sdlc-intents`. The runner has its own queue (`sdlc-runner`, C06).
import fs from 'node:fs';
import path from 'node:path';

import { INTENT_TASK_QUEUE } from '@sdlc/contracts';
import type { TemporalSettings } from '@sdlc/workflow-client';
import {
  bundleWorkflowCode,
  DefaultLogger,
  NativeConnection,
  Runtime,
  Worker,
  type LogLevel as TemporalLogLevel,
} from '@temporalio/worker';

import type { IntentActivities } from './activities/intent-activities.js';
import type { WorkerLogger } from './logger.js';

/**
 * The workflow code: bundled at image build time (`bundle-workflows.js`, setting
 * `SDLC_WORKER_WORKFLOW_BUNDLE`), or at start-up from the compiled workflow files.
 */
export const WORKFLOWS_PATH = path.join(__dirname, 'workflows', 'index.js');
export const WORKFLOW_BUNDLE_PATH = path.join(__dirname, 'workflow-bundle.js');

let runtimeInstalled = false;

/**
 * Sends the SDK's warnings and errors to the worker's JSON log. Installed once per process; the
 * SDK's messages carry no client data (workflow inputs are IDs).
 */
export function installTemporalLogging(logger: WorkerLogger): void {
  if (runtimeInstalled) return;
  runtimeInstalled = true;
  const level = (l: TemporalLogLevel) => (l === 'ERROR' ? 'error' : l === 'WARN' ? 'warn' : 'info');
  Runtime.install({
    logger: new DefaultLogger('WARN', (entry) => {
      logger.log(level(entry.level), 'temporal.log', { message: entry.message.slice(0, 500) });
    }),
  });
}

export interface IntentWorkerHandle {
  /** Resolves when the worker stopped; rejects when it failed. */
  readonly running: Promise<void>;
  shutdown(): Promise<void>;
}

export async function startIntentWorker(options: {
  readonly settings: TemporalSettings;
  readonly activities: IntentActivities;
  /** A bundle made by `bundle-workflows.js`; default: bundle the workflow files at start-up. */
  readonly workflowBundlePath?: string | null;
  /** Workflows kept in memory between tasks (SDK default). 0: every task replays from history. */
  readonly maxCachedWorkflows?: number;
  readonly connection?: NativeConnection;
}): Promise<IntentWorkerHandle> {
  const connection =
    options.connection ?? (await NativeConnection.connect({ address: options.settings.address }));
  const worker = await Worker.create({
    connection,
    namespace: options.settings.namespace,
    taskQueue: INTENT_TASK_QUEUE,
    ...(options.workflowBundlePath
      ? { workflowBundle: { codePath: options.workflowBundlePath } }
      : { workflowsPath: WORKFLOWS_PATH }),
    activities: { ...options.activities },
    ...(options.maxCachedWorkflows === undefined
      ? {}
      : { maxCachedWorkflows: options.maxCachedWorkflows }),
  });
  const running = worker.run();
  return {
    running,
    async shutdown() {
      if (worker.getState() === 'RUNNING') worker.shutdown();
      await running.catch(() => undefined);
      if (!options.connection) await connection.close();
    },
  };
}

/** Bundles the workflow code once (image build), so the worker needs no bundler at start-up. */
export async function writeWorkflowBundle(target: string = WORKFLOW_BUNDLE_PATH): Promise<void> {
  const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH });
  fs.writeFileSync(target, code);
}
