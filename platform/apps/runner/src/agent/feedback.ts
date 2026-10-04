// The feedback of the request for changes a run answers (task E01 PR 2, D-08 E01 AC4,
// design/ADR-M41 §2.7, QUESTIONS #179, #190).
//
// A valid request for changes at G7 takes the intent to G4; the next run starts from the pushed
// commit. Before the agent starts, the runner:
//   1. finds the request again from the database (`feedbackSourceFor`, core): the review or the
//      comment recorded as that decision, by its ID; never "the latest changes_requested review"
//      (anyone can review a public repository). The worker checked it before issuing any secret;
//      this is the second line;
//   2. opens the single-use wrapping token of its own feedback token (`pull_requests: read`, or
//      `issues: read` for a comment on the intent's issue), reads that one review (with its line
//      comments) or comment, and revokes the token at once, whatever the outcome;
//   3. checks it: a review must still be `changes_requested`, of the pushed commit; a comment must
//      still be a `/request-changes G7` command; the author must be the decider's linked account;
//   4. cleans the text (control and bidirectional characters) and caps it at
//      `REVIEW_FEEDBACK_MAX_CHARS`, then hands it to the agent's prompt, in memory only.
// The text never goes to Temporal, logs, run events or tables: `feedback_read` holds counts. Any
// failure ends the run `failed` (`agent_feedback_unavailable`, fail closed): the intent is paused
// with a `technical` escalation (or `security` when someone else opened the wrapping token).
import {
  GitHostError,
  type GitHostAdapter,
  type RedactedSecret,
  type ReviewFeedbackText,
  type RunContract,
  type SecretUnwrapper,
} from '@sdlc/contracts';
import {
  feedbackSourceFor,
  projectRepoRef,
  requestChangesReason,
  type FeedbackSource,
  type TenantScope,
} from '@sdlc/core';

import { isRefusedWrapToken, recordWrapTokenReused, revokeAfterUse } from '../tokens.js';
import { AgentRunError } from './errors.js';

/**
 * The cap of the feedback text in the agent's prompt, in characters. About 2,000 tokens: enough for
 * a review body and a dozen line comments. It bounds the prompt's cost and how much text a person
 * can put in front of the agent; GitHub allows 65,536 characters per body. Technical, not a
 * handbook rule.
 */
export const REVIEW_FEEDBACK_MAX_CHARS = 8000;

/** The note that ends a cut text (counted within the cap). */
const TRUNCATED_NOTE = '\n[The platform cut the feedback here.]';

/** What the runner reads with the feedback token: no App key (`GitHubAdapter` token-only). */
export type FeedbackReader = Pick<
  GitHostAdapter,
  'getReviewFeedback' | 'getIssueComment' | 'revokeShortLivedToken'
>;

export interface FeedbackAccess {
  readonly reader?: FeedbackReader | undefined;
  readonly unwrapper?: SecretUnwrapper | undefined;
  /** The single-use wrapping token of the run's feedback token (from the worker, via Temporal). */
  readonly wrappedToken?: RedactedSecret | undefined;
}

// C0 controls except tab and line feed, DEL, C1 controls, and Unicode bidirectional controls.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/** Cleans and caps a feedback text. Exported for tests. */
export function capFeedback(raw: string): { readonly text: string; readonly truncated: boolean } {
  const cleaned = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(UNSAFE, ' ').trim();
  if (cleaned.length <= REVIEW_FEEDBACK_MAX_CHARS) return { text: cleaned, truncated: false };
  let cut = cleaned.slice(0, REVIEW_FEEDBACK_MAX_CHARS - TRUNCATED_NOTE.length);
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: `${cut}${TRUNCATED_NOTE}`, truncated: true };
}

/**
 * The feedback of the request for changes the run answers, or undefined when the run answers
 * none. Throws `AgentRunError('feedback_unavailable')` after recording why (codes only).
 */
export async function readRunFeedback(
  scope: TenantScope,
  contract: RunContract,
  access: FeedbackAccess,
): Promise<ReviewFeedbackText | undefined> {
  const intent = await scope.intents.getById(contract.intent_id);
  if (!intent) throw await unavailable(scope, contract, 'intent_unknown');
  const lookup = await feedbackSourceFor(scope, intent);
  if (lookup.kind === 'none') return undefined;
  if (lookup.kind === 'unavailable') throw await unavailable(scope, contract, lookup.reason);
  const { source } = lookup;
  // The run starts from the commit the reviewer reviewed (G4, `lastPushedHead`).
  if (contract.base_sha !== source.pushedHead) {
    throw await unavailable(scope, contract, 'base_mismatch');
  }
  const project = await scope.projects.getById(intent.project_id);
  const ref = project ? projectRepoRef(project) : undefined;
  if (!ref || !access.reader || !access.unwrapper || !access.wrappedToken) {
    throw await unavailable(scope, contract, 'token_missing');
  }
  let token: RedactedSecret;
  try {
    const unwrapped = (await access.unwrapper.unwrap(access.wrappedToken)).token;
    if (!unwrapped) throw new Error('no token in the wrapping token');
    token = unwrapped;
  } catch (error) {
    // The contract is valid, so its wrapping token should be too: someone else opened it (C11).
    if (isRefusedWrapToken(error)) await recordWrapTokenReused(scope, contract.run_id, 'feedback');
    throw await unavailable(scope, contract, 'token_unavailable');
  }
  let read: { readonly text: string; readonly comments: number } | string;
  try {
    read = await readSource(access.reader, token, ref, source);
  } finally {
    await revokeAfterUse(access.reader, scope, contract.run_id, token, 'feedback');
  }
  if (typeof read === 'string') throw await unavailable(scope, contract, read);
  const capped = capFeedback(read.text);
  await scope.runEvents.append(contract.run_id, 'feedback_read', {
    source: source.kind,
    chars: capped.text.length,
    truncated: capped.truncated ? 'yes' : 'no',
    comments: read.comments,
  });
  return { source: source.kind, text: capped.text, truncated: capped.truncated };
}

/** Reads the recorded review or comment; a string is why it cannot be used (a code). */
async function readSource(
  reader: FeedbackReader,
  token: RedactedSecret,
  ref: NonNullable<ReturnType<typeof projectRepoRef>>,
  source: FeedbackSource,
): Promise<{ readonly text: string; readonly comments: number } | string> {
  try {
    if (source.kind === 'review') {
      const review = await reader.getReviewFeedback(token, ref, source.prNumber, source.externalId);
      if (review.reviewer.type !== 'user' || review.reviewer.id !== source.deciderAccountId) {
        return 'author_mismatch';
      }
      if (review.state !== 'changes_requested' || review.commitSha !== source.pushedHead) {
        return 'review_withdrawn';
      }
      const lines = review.comments.map(
        (c) => `- ${c.path}${c.line === null ? '' : `:${String(c.line)}`}\n  ${c.body.trim()}`,
      );
      const text = [
        review.body.trim(),
        ...(lines.length > 0 ? ['', 'Line comments:', ...lines] : []),
        ...(review.commentsTruncated ? ['(more line comments on the pull request)'] : []),
      ].join('\n');
      return { text, comments: review.comments.length };
    }
    const comment = await reader.getIssueComment(token, ref, source.externalId);
    if (comment.author.type !== 'user' || comment.author.id !== source.deciderAccountId) {
      return 'author_mismatch';
    }
    const reason = requestChangesReason(comment.body, 'G7');
    return reason === null ? 'comment_changed' : { text: reason, comments: 0 };
  } catch (error) {
    if (error instanceof GitHostError) return 'git_host_unavailable';
    throw error;
  }
}

async function unavailable(
  scope: TenantScope,
  contract: RunContract,
  reason: string,
): Promise<AgentRunError> {
  await scope.runEvents.append(contract.run_id, 'feedback_unavailable', { reason });
  return new AgentRunError('feedback_unavailable');
}
