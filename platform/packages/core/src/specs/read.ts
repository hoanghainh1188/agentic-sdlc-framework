// Reading a spec file from the Git host (task B08, design/ADR-M39 §2.3). The content is hashed and
// dropped at once: it is client data and never leaves this function (QUESTIONS #163).
import { GitHostError, type GitHostAdapter, type RepoRef } from '@sdlc/contracts';

import { SPEC_MAX_BYTES, specContentSha256, type SpecUnreadableCause } from './rules.js';

export type SpecRead =
  | { readonly kind: 'ok'; readonly sha256: string }
  | { readonly kind: 'unreadable'; readonly cause: SpecUnreadableCause };

const UNREADABLE: Readonly<Partial<Record<GitHostError['code'], SpecUnreadableCause>>> = {
  not_found: 'missing',
  not_a_file: 'not_a_file',
  file_too_large: 'too_large',
  file_not_utf8: 'not_utf8',
};

/**
 * The SHA-256 of the file at `path` and `commitSha`, or why it cannot be read. Throws
 * `GitHostError` when the Git host itself failed (unavailable, rate limited, no access): the
 * caller waits and tries again; it never treats that as a fact about the file.
 */
export async function readSpec(
  gitHost: Pick<GitHostAdapter, 'getFileAtCommit'>,
  ref: RepoRef,
  path: string,
  commitSha: string,
): Promise<SpecRead> {
  let text: string;
  try {
    text = await gitHost.getFileAtCommit(ref, path, commitSha);
  } catch (error) {
    const cause = error instanceof GitHostError ? UNREADABLE[error.code] : undefined;
    if (cause) return { kind: 'unreadable', cause };
    throw error;
  }
  if (Buffer.byteLength(text, 'utf8') > SPEC_MAX_BYTES) {
    return { kind: 'unreadable', cause: 'too_large' };
  }
  return { kind: 'ok', sha256: specContentSha256(text) };
}
