// Reading a plan file from the Git host (task B09, design/ADR-M40 §2.2). The text is parsed or
// hashed and dropped: it holds free text that stays in the repository.
import { GitHostError, type GitHostAdapter, type RepoRef } from '@sdlc/contracts';

import { PLAN_MAX_BYTES, planFileSha256, planPath, type PlanUnreadableCause } from './rules.js';

export type PlanFileRead =
  | { readonly kind: 'ok'; readonly text: string; readonly sha256: string }
  | { readonly kind: 'unreadable'; readonly cause: PlanUnreadableCause };

const UNREADABLE: Readonly<Partial<Record<GitHostError['code'], PlanUnreadableCause>>> = {
  not_found: 'missing',
  not_a_file: 'not_a_file',
  file_too_large: 'too_large',
  file_not_utf8: 'not_utf8',
};

/**
 * The intent's plan file at `commitSha`, or why it cannot be read. Throws `GitHostError` when the
 * Git host itself failed (unavailable, rate limited, no access): the caller waits and tries
 * again; it never treats that as a fact about the file.
 */
export async function readPlanFile(
  gitHost: Pick<GitHostAdapter, 'getFileAtCommit'>,
  ref: RepoRef,
  intentCode: string,
  commitSha: string,
): Promise<PlanFileRead> {
  let text: string;
  try {
    text = await gitHost.getFileAtCommit(ref, planPath(intentCode), commitSha);
  } catch (error) {
    const cause = error instanceof GitHostError ? UNREADABLE[error.code] : undefined;
    if (cause) return { kind: 'unreadable', cause };
    throw error;
  }
  if (Buffer.byteLength(text, 'utf8') > PLAN_MAX_BYTES) {
    return { kind: 'unreadable', cause: 'too_large' };
  }
  return { kind: 'ok', text, sha256: planFileSha256(text) };
}
