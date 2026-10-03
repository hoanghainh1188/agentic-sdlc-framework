// What the database says about the push of a run and the intent's agent branch (task C08,
// design/ADR-M38 §2.1–§2.2). The run events are the source of truth: the runner records
// `branch_pushed`, `publish_refused` or `publish_failed` in the database before it answers.
import type { Intent, Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** Failed push attempts of one run before G6 stops and a person decides (QUESTIONS #156). */
export const MAX_PUBLISH_ATTEMPTS = 3;

/** Delay before the workflow tries a failed push again. */
export const PUBLISH_RETRY_MS = 60_000;

export interface PublishState {
  /** The commit the runner pushed for the run, when it did. */
  readonly pushed: {
    readonly headSha: string;
    readonly parentSha: string;
    readonly diffSha256: string;
  } | null;
  /** The runner's final refusal code (`empty_diff`, `diff_mismatch`, `branch_moved`…). */
  readonly refused: string | null;
  /** Failed attempts (a cause that may pass). */
  readonly failures: number;
  /** The diff G5 checked (`diff_stored`), when the runner recorded one. */
  readonly diffSha256: string | null;
}

export async function publishState(tx: TenantScope, runId: string): Promise<PublishState> {
  let pushed: PublishState['pushed'] = null;
  let refused: string | null = null;
  let failures = 0;
  let diffSha256: string | null = null;
  for (const event of await tx.runEvents.list(runId)) {
    const p = event.payload;
    if (event.event_type === 'diff_stored') diffSha256 = String(p.sha256);
    else if (event.event_type === 'branch_pushed') {
      pushed = {
        headSha: String(p.head_sha),
        parentSha: String(p.parent_sha),
        diffSha256: String(p.diff_sha256),
      };
    } else if (event.event_type === 'publish_refused') refused = String(p.reason);
    else if (event.event_type === 'publish_failed') failures += 1;
  }
  return { pushed, refused, failures, diffSha256 };
}

/**
 * The commit the runner last pushed on the intent's agent branch, or null when nothing was pushed
 * yet. G4 starts the next run there (QUESTIONS #134, D-08 C08 note): the run's diff is then the
 * change on top of what is already in the pull request. The recorded commit, not the branch's live
 * head: a commit someone else pushed is never built on (the push of the next run is then refused,
 * `branch_moved`).
 */
export async function lastPushedHead(
  tx: TenantScope,
  intentId: Intent['id'],
): Promise<string | null> {
  const runs = await tx.runs.listForIntent(intentId);
  for (const run of [...runs].reverse()) {
    const state = await publishState(tx, run.id);
    if (state.pushed) return state.pushed.headSha;
  }
  return null;
}

/** The intent's latest run (the run G5 passed when the intent waits at G6). */
export async function latestRun(tx: TenantScope, intentId: string): Promise<Run | undefined> {
  return (await tx.runs.listForIntent(intentId)).at(-1);
}
