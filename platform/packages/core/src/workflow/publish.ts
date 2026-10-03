// The worker's side of the push and the pull request at G6 (task C08 PR 1, D-08 C08 AC1,
// design/ADR-M38 §2.1–§2.4, QUESTIONS #52, #123, #156).
//
// `preparePublish`, just before the runner's `publishRun`: checks under the intent lock that the
// intent still waits at G6 for this run's push (the step's conditions: the run is the latest and
// succeeded, nothing pushed or refused, attempts left, the G5 block window closed, `push` not
// frozen), then issues a single-repository GitHub token with `contents: write` for this push only
// and hands it over as a single-use OpenBao wrapping token (`PUSH_TOKEN_WRAP_SECONDS`). Only the
// wrapping token travels on: no secret and no client data in the Temporal history (ADR-M30 §2.1).
//
// `finishPublish`, after the push: finds the open pull request from the agent branch into the
// default branch, or opens it (title and body from the message catalog, coded values only: the
// pilot repository is public, QUESTIONS #123), checks that it shows the pushed commit, and links
// it to the intent (`intents.pr_number`, audit `intent.pr_linked`, notice `pr_opened`). A pull
// request whose head is not the pushed commit means someone else changed the branch: the run event
// `publish_refused` (`branch_moved`) and the G6 step pauses the intent (QUESTIONS #156).
// Both are idempotent: the database says what is done, so a retry finds its way.
import {
  GitHostError,
  type GitHostAdapter,
  type PullRequestInfo,
  type RedactedSecret,
  type SecretWrapper,
} from '@sdlc/contracts';
import { t } from '@sdlc/messages';

import type { Intent, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { Registry } from '../registry/registry.js';
import { EscalationError } from '../escalation/errors.js';
import { assertActionAllowed } from '../escalation/freeze.js';
import { projectRepoRef } from './g4-proposal.js';
import { hotlBlockWindowOpenUntil } from './hotl.js';
import { latestRun, MAX_PUBLISH_ATTEMPTS, publishState } from './publish-state.js';

/**
 * Life of the push token's wrapping token: long enough for the runner's queue to pick the
 * activity up, short enough that a lost one is useless soon (ADR-M38 §2.3). The token itself lives
 * as long as GitHub allows (one hour) in the runner's memory only.
 */
export const PUSH_TOKEN_WRAP_SECONDS = 600;

export interface PublishDeps {
  readonly registry: Registry;
  readonly gitHost: Pick<
    GitHostAdapter,
    'issueShortLivedToken' | 'openPullRequest' | 'findOpenPullRequest'
  >;
  readonly wrapper: SecretWrapper;
}

export type PreparePublishResult =
  | { readonly ok: true; readonly wrappedPushToken: RedactedSecret }
  /** The step's conditions do not hold any more; the workflow asks the step again. */
  | { readonly ok: false; readonly reason: 'not_ready' }
  /** The push token could not be issued or wrapped (counted as a failed attempt). */
  | { readonly ok: false; readonly reason: 'token_failed' };

export type FinishPublishResult =
  | { readonly ok: true; readonly prNumber: number }
  | {
      readonly ok: false;
      /** `pr_failed`: the Git host refused or failed (counted as a failed attempt). */
      readonly reason: 'not_ready' | 'branch_moved' | 'pr_mismatch' | 'pr_failed';
    };

const isAtG6 = (intent: Intent | undefined): intent is Intent =>
  intent?.status === 'in_gate' && intent.current_gate === 'G6';

async function frozen(
  tx: TenantScope,
  intentId: string,
  action: 'push' | 'open_pr',
  now: Date,
): Promise<boolean> {
  try {
    await assertActionAllowed(tx, intentId, action, now);
    return false;
  } catch (error) {
    if (error instanceof EscalationError && error.code === 'frozen') return true;
    throw error;
  }
}

/** Checks the push may happen now and returns the wrapped push token (see the header). */
export async function preparePublish(
  scope: TenantScope,
  deps: PublishDeps,
  intentId: string,
  runId: string,
): Promise<PreparePublishResult> {
  const ready = await scope.transaction(async (tx) => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (!isAtG6(intent)) return undefined;
    const run = await latestRun(tx, intentId);
    if (run?.id !== runId || run.status !== 'succeeded') return undefined;
    const state = await publishState(tx, runId);
    if (state.pushed || state.refused || state.failures >= MAX_PUBLISH_ATTEMPTS) return undefined;
    const now = deps.registry.now();
    if ((await hotlBlockWindowOpenUntil(tx, deps.registry, intentId, now)) !== null) {
      return undefined;
    }
    if (await frozen(tx, intentId, 'push', now)) return undefined;
    return { intent, run };
  });
  if (!ready) return { ok: false, reason: 'not_ready' };
  const project = await scope.projects.getById(ready.intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!ref) throw new GitHostError('invalid_input', { field: 'repo' });
  try {
    const token = await deps.gitHost.issueShortLivedToken(ref, {
      permissions: { contents: 'write' },
    });
    const wrappedPushToken = await deps.wrapper.wrap(
      { token: token.token },
      { ttlSeconds: PUSH_TOKEN_WRAP_SECONDS },
    );
    return { ok: true, wrappedPushToken };
  } catch {
    // Counted like a failed push (the App lacks the permission, GitHub or OpenBao is down): after
    // `MAX_PUBLISH_ATTEMPTS` G6 stops instead of asking for a token for ever (code review).
    await scope.runEvents.append(runId, 'publish_failed', { reason: 'token_failed' });
    return { ok: false, reason: 'token_failed' };
  }
}

/** Finds or opens the pull request and links it (see the header). */
export async function finishPublish(
  scope: TenantScope,
  deps: PublishDeps,
  intentId: string,
  runId: string,
): Promise<FinishPublishResult> {
  const peek = await scope.intents.getById(intentId);
  if (!isAtG6(peek)) return { ok: false, reason: 'not_ready' };
  const run = await latestRun(scope, intentId);
  if (run?.id !== runId) return { ok: false, reason: 'not_ready' };
  const state = await publishState(scope, runId);
  if (!state.pushed) return { ok: false, reason: 'not_ready' };
  if (await frozen(scope, intentId, 'open_pr', deps.registry.now())) {
    return { ok: false, reason: 'not_ready' };
  }
  const project = await scope.projects.getById(peek.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!project || !ref) throw new GitHostError('invalid_input', { field: 'repo' });

  let pr: PullRequestInfo | null = null;
  if (peek.pr_number === null) {
    try {
      pr =
        (await deps.gitHost.findOpenPullRequest(ref, run.branch, project.default_branch)) ??
        (await deps.gitHost.openPullRequest(ref, {
          head: run.branch,
          base: project.default_branch,
          title: t('pr.title', { code: peek.code, run_short: run.id.slice(0, 8) }),
          body: await pullRequestBody(scope, peek, run, state.pushed.diffSha256),
        }));
    } catch (error) {
      if (!(error instanceof GitHostError)) throw error;
      // Counted like a failed push: after `MAX_PUBLISH_ATTEMPTS` G6 stops (QUESTIONS #156).
      await scope.runEvents.append(runId, 'publish_failed', { reason: 'pr_failed' });
      return { ok: false, reason: 'pr_failed' };
    }
  }
  const pushedHead = state.pushed.headSha;
  return scope.transaction(async (tx): Promise<FinishPublishResult> => {
    const intent = await tx.intents.lockAndGet(intentId);
    if (!isAtG6(intent)) return { ok: false, reason: 'not_ready' };
    if (pr === null) {
      // Linked by an earlier call (the step then waits for CI).
      return intent.pr_number === null
        ? { ok: false, reason: 'not_ready' }
        : { ok: true, prNumber: intent.pr_number };
    }
    if (pr.headSha !== pushedHead) {
      // GitHub updates a pull request's head shortly after a push: a counted retry first; a branch
      // someone else moved stays different and stops G6 after `MAX_PUBLISH_ATTEMPTS` (code review).
      await tx.runEvents.append(runId, 'publish_failed', { reason: 'pr_head_differs' });
      return { ok: false, reason: 'pr_failed' };
    }
    if (!(await tx.intents.linkPullRequest(intentId, link(pr, runId, pushedHead)))) {
      await refuse(tx, runId, 'pr_mismatch');
      return { ok: false, reason: 'pr_mismatch' };
    }
    await tx.intentNotices.record({
      intentId,
      kind: 'pr_opened',
      status: intent.status,
      gate: intent.current_gate,
      previousGate: intent.current_gate,
      decisionId: null,
      audienceRoles: ['person_b'],
    });
    return { ok: true, prNumber: pr.number };
  });
}

/** A coded contract field as text, or a dash. */
function codeOr(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : '—';
}

/**
 * The runner's push activity was lost (heartbeat timeout, the runner stopped: `runner_lost`), or a
 * worker activity of the round failed unexpectedly (`worker_failed`): counted as a failed attempt
 * unless the round is already done or refused, so nothing makes the workflow try for ever
 * (`MAX_PUBLISH_ATTEMPTS`).
 */
export async function abandonPublish(
  scope: TenantScope,
  intentId: string,
  runId: string,
  reason: 'runner_lost' | 'worker_failed' = 'runner_lost',
): Promise<void> {
  await scope.transaction(async (tx) => {
    const run = await tx.runs.getById(runId);
    if (!run) return;
    const state = await publishState(tx, runId);
    const intent = await tx.intents.getById(intentId);
    if (state.refused || (state.pushed && intent?.pr_number !== null)) return;
    await tx.runEvents.append(runId, 'publish_failed', { reason });
  });
}

function link(
  pr: PullRequestInfo,
  runId: string,
  headSha: string,
): { prNumber: number; runId: string; headSha: string } {
  return { prNumber: pr.number, runId, headSha };
}

async function refuse(tx: TenantScope, runId: string, reason: string): Promise<void> {
  await tx.runEvents.append(runId, 'publish_refused', { reason });
}

/**
 * Template T2 filled with coded values only (QUESTIONS #123): codes, IDs and hashes; never the
 * intent's title or description, the paths, or any text from the agent.
 */
export async function pullRequestBody(
  scope: TenantScope,
  intent: Intent,
  run: Run,
  diffSha256: string,
): Promise<string> {
  const contract = (await scope.runContracts.getByRunId(run.id))?.contract_json;
  const agent = await scope.agents.getById(run.agent_id);
  return t('pr.body', {
    code: intent.code,
    issue: intent.issue_number === null ? '' : t('pr.issue', { issue: intent.issue_number }),
    run_id: run.id,
    agent: agent?.agent_key ?? '—',
    agent_version: run.agent_version,
    model: agent?.version === run.agent_version ? (agent.model_ref ?? '—') : '—',
    autonomy: codeOr(contract?.autonomy_level),
    plan_sha256: codeOr(contract?.plan_sha256),
    diff_sha256: diffSha256,
  });
}
