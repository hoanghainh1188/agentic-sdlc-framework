// G7 reviews become gate decisions (task E01, D-08 E01 AC1–AC3, design/ADR-M41 §2.4,
// QUESTIONS #175, #176, #179).
//
// GitHub reviews are the approvals of G7 (#175): the latest decision of each reviewer, of the
// commit the platform pushed. The step records each one once, under the intent lock:
//   - `approved` → an `approve` through the registry, which checks the approver with the policy
//     engine (the gate's roles, the producers, two different people for dual approval);
//   - `changes_requested` → a `request_changes` (reason `other`, the review's URL as
//     `reason_ref`), only from a holder of the gate's role who is not a producer (#179: the review
//     whose text the next run reads is identified by this decision);
//   - a bot never decides; neither does an account not linked to an active user; neither gets a
//     reply (Harry, review of PR #138: no spam through a public repository).
// Each review gets a `git_event_receipts` row with its event ID (#176): it is recorded once, and a
// refusal of a linked user gets one reply comment on the pull request with catalog codes only.
// An approval whose review was dismissed or replaced since, or that reviewed another commit, is
// voided (`input_mismatch`, FR-17).
import type { ReviewDecision } from '@sdlc/contracts';

import { refusalReply, userOfAccount, type Reply } from '../commands/git-event-handler.js';
import type { Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { GitProvider } from '../db/vocabulary.js';
import { RegistryError } from '../registry/errors.js';
import type { Registry } from '../registry/registry.js';
import { waitedSeconds } from './waited.js';

const GATE = { gate: 'G7' } as const;

export interface ReviewContext {
  readonly intent: Intent;
  readonly provider: GitProvider;
  readonly prNumber: number;
  /** The commit the platform pushed; only reviews of it count. */
  readonly headSha: string;
  readonly inputSha256: string;
  readonly producers: readonly string[];
  /** When the pull request was merged; reviews submitted later are late (QUESTIONS #177). */
  readonly mergedAt: Date | null;
  /** A `resume` on a G7 merge escalation for this input lets late approvals count (#177). */
  readonly lateAllowed: boolean;
}

/** Records the reviews that have no receipt yet. Under the intent lock. */
export async function recordReviews(
  tx: TenantScope,
  registry: Registry,
  ctx: ReviewContext,
  reviews: readonly ReviewDecision[],
): Promise<void> {
  for (const review of reviews) {
    if (review.state === 'dismissed' || review.commitSha !== ctx.headSha) continue;
    if (ctx.mergedAt !== null) {
      // After the merge, a request for changes has nothing left to change; late approvals count
      // only after a person accepted the early merge.
      if (review.state !== 'approved') continue;
      if (!ctx.lateAllowed && new Date(review.submittedAt) > ctx.mergedAt) continue;
    }
    if (await tx.gitEventReceipts.find(ctx.intent.project_id, review.eventId)) continue;
    await tx.gitEventReceipts.record(await receiptOf(tx, registry, ctx, review));
  }
}

async function receiptOf(
  tx: TenantScope,
  registry: Registry,
  ctx: ReviewContext,
  review: ReviewDecision,
) {
  const base = {
    projectId: ctx.intent.project_id,
    eventId: review.eventId,
    issueNumber: ctx.prNumber,
  };
  // Bots never decide, and get no reply, so replies never loop (QUESTIONS #45).
  if (review.reviewer.type === 'bot') return { ...base, outcome: 'ignored_bot' };
  const actorId = await userOfAccount(tx, ctx.provider, review.reviewer.id);
  // Harry, review of PR #138: anyone can review a public repository; an account not linked to a
  // user gets no reply, so nobody can make the platform spam a pull request or burn API quota.
  if (actorId === undefined) return { ...base, outcome: 'user_not_linked' };
  if (review.state === 'changes_requested' && ctx.producers.includes(actorId)) {
    return {
      ...base,
      outcome: 'refused',
      reply: reply('decision_not_allowed', { reason: 'producer' }),
    };
  }
  try {
    const decision = await tx.savepoint((sp) =>
      registry.decide(sp, {
        intentId: ctx.intent.id,
        gate: 'G7',
        decision: review.state === 'approved' ? 'approve' : 'request_changes',
        actor: { type: 'human', id: actorId },
        producers: ctx.producers,
        inputSha256: ctx.inputSha256,
        ...(review.state === 'approved' ? {} : { reasonCode: 'other' as const }),
        reasonRef:
          review.url.length <= 512 && /^https:\/\/\S+$/.test(review.url) ? review.url : null,
        waitedSeconds: waitedSeconds(ctx.intent, registry.now()),
        source: 'github_review',
        eventSource: 'polling',
      }),
    );
    return { ...base, outcome: 'decided', gateDecisionId: decision.id };
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error;
    const refusal = refusalReply(error, GATE);
    if (refusal === undefined) throw error;
    return { ...base, outcome: refusal.code === 'failed' ? 'failed' : 'refused', reply: refusal };
  }
}

function reply(code: Reply['code'], extra: Readonly<Record<string, string>> = {}): Reply {
  return { code, params: { ...GATE, ...extra } };
}

/**
 * Voids the G7 approvals whose review no longer holds: dismissed, replaced by a later decision of
 * the same reviewer, gone, or of another commit (FR-17, `input_mismatch`). Under the intent lock.
 */
export async function voidStaleReviewApprovals(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
  headSha: string,
  reviews: readonly ReviewDecision[],
): Promise<void> {
  for (const approval of await tx.gateDecisions.currentApprovalsFor(intent.id, 'G7')) {
    const receipt = await tx.gitEventReceipts.findByDecision(approval.id);
    if (!receipt) continue;
    const review = reviews.find((r) => r.eventId === receipt.event_id);
    if (review?.state === 'approved' && review.commitSha === headSha) continue;
    await registry.voidApproval(tx, {
      intentId: intent.id,
      decisionId: approval.id,
      reasonCode: 'input_mismatch',
    });
  }
}
