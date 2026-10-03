// Activities of the intent workflow (task B07, design/ADR-M30; C06 session 2, ADR-M33 §2.6). They
// run in the worker process with the database and the registry; the workflow only sees their
// coded results. The run activities return IDs, codes and two single-use OpenBao wrapping tokens:
// never a raw token, a virtual key, its ID or client data (ADR-M30 §2.1, QUESTIONS #112).
import type { IntentStepResult, IntentWorkflowRef } from '@sdlc/contracts';
import {
  abandonPublish,
  abandonRun,
  finishPublish,
  finishRun,
  parseTenantId,
  preparePublish,
  startRun,
  stepIntent,
  type G4Deps,
  type PlatformDatabase,
  type PublishDeps,
  type Registry,
  type RunDeps,
} from '@sdlc/core';

export type PrepareRunActivityResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly modelRef: string;
      readonly wrappedGitToken: string;
      readonly wrappedVirtualKey: string;
    }
  | { readonly ok: false; readonly reason: string };

/** C08: the wrapped push token, or the step's conditions no longer hold. */
export type PreparePublishActivityResult =
  | { readonly ok: true; readonly wrappedPushToken: string }
  | { readonly ok: false; readonly reason: string };

/** C08: the pull request is linked, or why not (codes only). */
export type FinishPublishActivityResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface IntentActivities {
  /** One step of the intent (core `stepIntent`): at most one move, in one transaction. */
  stepIntent(ref: IntentWorkflowRef): Promise<IntentStepResult>;
  /** C06: the round's next run (core `startRun`). */
  prepareRun(ref: IntentWorkflowRef): Promise<PrepareRunActivityResult>;
  /** C06: the run ended; revoke its key, sync spend, move the intent (core `finishRun`). */
  finishRun(ref: IntentWorkflowRef, runId: string): Promise<void>;
  /** C06: the runner's activity was lost; revoke the key at once, fail the run (core `abandonRun`). */
  abandonRun(ref: IntentWorkflowRef, runId: string): Promise<void>;
  /** C08: a push token for the run's push, wrapped (core `preparePublish`). */
  preparePublish(ref: IntentWorkflowRef, runId: string): Promise<PreparePublishActivityResult>;
  /** C08: find or open the pull request and link it (core `finishPublish`). */
  finishPublish(ref: IntentWorkflowRef, runId: string): Promise<FinishPublishActivityResult>;
  /** C08: the runner's push activity or a worker activity failed; count a failed attempt. */
  abandonPublish(
    ref: IntentWorkflowRef,
    runId: string,
    reason: 'runner_lost' | 'worker_failed',
  ): Promise<void>;
}

export interface IntentActivityDeps {
  readonly db: Pick<PlatformDatabase, 'forTenant'>;
  readonly registry: Registry;
  /** G4 facts from outside the database (C06). Without it G4 is not evaluated. */
  readonly g4?: G4Deps;
  /** Everything a run needs (C06 session 2). Without it a decided G4 waits (`run_pending`). */
  readonly runs?: RunDeps;
  /** The push and the pull request at G6 (C08). Wired with `runs`. */
  readonly publish?: PublishDeps;
}

/** Thrown by a run activity when the worker was started without run support. */
export class RunsNotConfiguredError extends Error {
  override readonly name = 'RunsNotConfiguredError';
}

export function createIntentActivities(deps: IntentActivityDeps): IntentActivities {
  const scope = (ref: IntentWorkflowRef) => deps.db.forTenant(parseTenantId(ref.tenantId));
  const runs = (): RunDeps => {
    if (!deps.runs) throw new RunsNotConfiguredError('runs are not configured in this worker');
    return deps.runs;
  };
  const publish = (): PublishDeps => {
    if (!deps.publish) throw new RunsNotConfiguredError('runs are not configured in this worker');
    return deps.publish;
  };
  return {
    stepIntent: (ref) =>
      stepIntent(
        scope(ref),
        {
          registry: deps.registry,
          ...(deps.g4 ? { g4: deps.g4 } : {}),
          ...(deps.g4 && deps.runs ? { startRuns: true } : {}),
          ...(deps.publish ? { publish: true } : {}),
        },
        ref.intentId,
      ),
    async prepareRun(ref) {
      const result = await startRun(scope(ref), runs(), ref.intentId);
      if (!result.ok) return { ok: false, reason: result.reason };
      return {
        ok: true,
        runId: result.run.runId,
        modelRef: result.run.modelRef,
        wrappedGitToken: result.run.wrappedGitToken.reveal(),
        wrappedVirtualKey: result.run.wrappedVirtualKey.reveal(),
      };
    },
    finishRun: (ref, runId) => finishRun(scope(ref), runs(), ref.intentId, runId),
    abandonRun: (ref, runId) => abandonRun(scope(ref), runs(), runId),
    async preparePublish(ref, runId) {
      const result = await preparePublish(scope(ref), publish(), ref.intentId, runId);
      return result.ok
        ? { ok: true, wrappedPushToken: result.wrappedPushToken.reveal() }
        : { ok: false, reason: result.reason };
    },
    async finishPublish(ref, runId) {
      const result = await finishPublish(scope(ref), publish(), ref.intentId, runId);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    abandonPublish: (ref, runId, reason) => abandonPublish(scope(ref), ref.intentId, runId, reason),
  };
}
