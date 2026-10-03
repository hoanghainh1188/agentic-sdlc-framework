// The runner's Temporal activity (task C06 session 2, D-08 C06 AC4, design/ADR-M33 §2.6, ADR-M25
// §2.7, QUESTIONS #53, #55). The runner process is a Temporal worker on the task queue
// `sdlc-runner`; its activity slots are `SDLC_RUNNER_MAX_SANDBOXES`, so extra runs wait in
// Temporal. The slot pool of `Runner` stays as the backstop.
//
// `executeRun`, one attempt per run:
// 1. read the signed contract the worker stored (the input holds the run's ID only);
// 2. provision (verify the contract, claim the run, unwrap the GitHub token, clone, sandbox);
//    a refusal (`expired`, …) or a provisioning failure is returned as `refused` with its code;
// 3. unwrap the run's virtual key (a single-use wrapping token: someone who opened it first makes
//    the run fail, `key_unavailable`);
// 4. drive the agent to its end (C05), then the sandbox is removed and the slot freed (`Runner`).
// A heartbeat goes to Temporal every `HEARTBEAT_MS` while the activity lives; the workflow treats a
// lost heartbeat as a lost runner (ADR-M33 §2.7). When the activity is cancelled (the runner stops
// gracefully, or the workflow cancels it for the kill switch, C11), the driver stops the agent
// first (interrupt, then kill), the run ends `failed` (`agent_cancelled`), or `stopped_killed` when
// it is being killed (`stopping`), and the sandbox is removed; there is never a
// teardown while the agent is being driven. After a runner restart, the clean-up at start and the
// sweep remove what is left (ADR-M25 §2.8).
// The result holds codes only; paths, logs and texts never go to Temporal.
//
// `publishRun` (C08, ADR-M38 §2.2): after G5 passed, the push of the run's checked changes
// (`workspace/publish.ts`). One attempt; it takes an activity slot like a run, for a short time.
import type {
  ExecuteRunInput,
  ExecuteRunResult,
  PublishRunInput,
  PublishRunResult,
  RunnerActivities,
  SecretUnwrapper,
} from '@sdlc/contracts';
import { parseTenantId, type PlatformDatabase, type PlatformLogger } from '@sdlc/core';
import { Redacted } from '@sdlc/secrets';
import { Context } from '@temporalio/activity';

import type { Runner } from './runner.js';
import { isRefusedWrapToken, recordWrapTokenReused } from './tokens.js';
import { publishRun, type PublishDeps } from './workspace/publish.js';

/** Heartbeat interval; the workflow's heartbeat timeout is 2 minutes. */
export const HEARTBEAT_MS = 30_000;

/** What an activity needs from Temporal's context (tests pass a fake). */
export interface ActivityContextLike {
  heartbeat(): void;
  readonly cancellationSignal: AbortSignal;
}

export interface RunnerActivityDeps {
  readonly db: PlatformDatabase;
  readonly runner: Pick<Runner, 'provision' | 'runAgent' | 'release'>;
  readonly unwrapper: SecretUnwrapper;
  /** Default: `Context.current()`. */
  readonly context?: () => ActivityContextLike;
  readonly heartbeatMs?: number;
  /** Start and end of each run (codes only); the activity's log context adds tenant and run. */
  readonly logger?: PlatformLogger;
  /** C08: what the push needs besides the database and the unwrapper. */
  readonly publish?: Omit<PublishDeps, 'db' | 'unwrapper'>;
}

export function createRunnerActivities(deps: RunnerActivityDeps): RunnerActivities {
  return {
    async executeRun(input: ExecuteRunInput): Promise<ExecuteRunResult> {
      const ctx = (deps.context ?? (() => Context.current()))();
      ctx.heartbeat();
      const beat = setInterval(() => ctx.heartbeat(), deps.heartbeatMs ?? HEARTBEAT_MS);
      deps.logger?.log('info', 'runner.run_started', {});
      try {
        const result = await execute(deps, ctx, input);
        deps.logger?.log(
          'info',
          'runner.run_ended',
          result.outcome === 'ended'
            ? { outcome: 'ended', status: result.status, stop_reason: result.stopReason ?? '' }
            : { outcome: 'refused', reason: result.reason },
        );
        return result;
      } finally {
        clearInterval(beat);
      }
    },
    async publishRun(input: PublishRunInput): Promise<PublishRunResult> {
      const ctx = (deps.context ?? (() => Context.current()))();
      ctx.heartbeat();
      const beat = setInterval(() => ctx.heartbeat(), deps.heartbeatMs ?? HEARTBEAT_MS);
      try {
        const result = deps.publish
          ? await publishRun({ ...deps.publish, db: deps.db, unwrapper: deps.unwrapper }, input)
          : await publishOff(deps, input);
        deps.logger?.log(
          result.outcome === 'pushed' ? 'info' : 'warn',
          'runner.publish_ended',
          result.outcome === 'pushed'
            ? { outcome: 'pushed' }
            : { outcome: result.outcome, reason: result.reason },
        );
        return result;
      } finally {
        clearInterval(beat);
      }
    },
  };
}

/** A runner without publish settings: counted as a failed attempt, so G6 stops (code review). */
async function publishOff(
  deps: RunnerActivityDeps,
  input: PublishRunInput,
): Promise<PublishRunResult> {
  await deps.db
    .forTenant(parseTenantId(input.tenantId))
    .runEvents.append(input.runId, 'publish_failed', { reason: 'publish_off' });
  return { outcome: 'failed', reason: 'publish_off' };
}

async function execute(
  deps: RunnerActivityDeps,
  ctx: ActivityContextLike,
  input: ExecuteRunInput,
): Promise<ExecuteRunResult> {
  const scope = deps.db.forTenant(parseTenantId(input.tenantId));
  const stored = await scope.runContracts.getByRunId(input.runId);
  if (!stored) return { outcome: 'refused', reason: 'unknown_contract' };
  const provisioned = await deps.runner.provision(
    {
      envelope: { contract: stored.contract_json, signature: stored.signature },
      wrappedGitToken: new Redacted(input.wrappedGitToken),
    },
    ctx.cancellationSignal,
  );
  if (!provisioned.ok) return { outcome: 'refused', reason: provisioned.reason };
  const { contract, sandbox } = provisioned;
  let virtualKey;
  try {
    virtualKey = (await deps.unwrapper.unwrap(new Redacted(input.wrappedVirtualKey))).key;
  } catch (error) {
    virtualKey = undefined;
    // The contract is valid, so its wrapping token should be too: someone else opened it (C11).
    if (isRefusedWrapToken(error)) {
      await recordWrapTokenReused(scope, input.runId, 'virtual_key');
    }
  }
  const killed = (await scope.runs.getById(input.runId))?.status === 'stopping';
  if (!virtualKey || ctx.cancellationSignal.aborted || killed) {
    await deps.runner.release(input.tenantId, input.runId, virtualKey ? 'killed' : 'failed');
    const now = new Date();
    // A run being killed ends as killed (C11, migration 0020); otherwise it fails. One update.
    await scope.runs.end(input.runId, {
      from: ['provisioning', 'running'],
      to: 'failed',
      now,
      stopReason: virtualKey ? 'agent_cancelled' : 'key_unavailable',
      finishedAt: now,
    });
  } else {
    // A cancel stops the agent first (interrupt, then kill); `runAgent` then removes the sandbox.
    await deps.runner.runAgent({
      contract,
      sandbox,
      model: input.modelRef,
      virtualKey,
      signal: ctx.cancellationSignal,
    });
  }
  const run = await scope.runs.getById(input.runId);
  return {
    outcome: 'ended',
    status: run?.status ?? 'failed',
    stopReason: run?.stop_reason ?? null,
  };
}
