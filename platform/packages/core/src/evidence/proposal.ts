// Reading an L1 proposal (task C13, design/ADR-M64 §2.1, QUESTIONS #336). The patch is client code:
// a person with a role in `access.evidence_read_roles` (tenant admins always) reads it through the
// api, which checks its SHA-256 and size against `evidence_items` first. A mismatch, a missing or
// an oversized file is refused (fail closed) and audited `evidence.check_failed`, as when a pack
// is built; every read that succeeds is audited `evidence.proposal_read` (the run, the hash, the
// size; never the content). The bytes are returned to the caller only, never logged or kept.
import { createHash } from 'node:crypto';

import { EvidenceError, PROPOSAL_MAX_BYTES, type EvidenceStore } from '@sdlc/contracts';

import type { EvidenceItem } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { resolveEvidenceSubject, type EvidenceActor } from './access.js';
import { EvidencePackError } from './errors.js';

export interface ProposalReadDeps {
  readonly store: EvidenceStore;
  readonly now: () => Date;
  readonly maxItemBytes: number;
}

export interface ProposalReadResult {
  readonly intentCode: string;
  readonly item: EvidenceItem & { readonly run_id: string };
  readonly content: Buffer;
}

type CheckFailure = 'hash_mismatch' | 'size_mismatch' | 'missing';

const FAILURE_CODE = {
  hash_mismatch: 'evidence_hash_mismatch',
  size_mismatch: 'evidence_hash_mismatch',
  missing: 'evidence_missing',
} as const;

/**
 * The stored proposal of one run of the intent (`runId`), or of its latest run with one, read
 * back and checked. Only a human reads it: the platform never needs the patch's content.
 */
export async function readProposal(
  scope: TenantScope,
  actor: { readonly type: 'human'; readonly userId: string },
  intentRef: string,
  runId: string | undefined,
  deps: ProposalReadDeps,
): Promise<ProposalReadResult> {
  const subject: EvidenceActor = actor;
  const { intent } = await resolveEvidenceSubject(scope, subject, intentRef, 'read');
  const proposals = (await scope.evidenceItems.listForIntent(intent.id)).filter(
    (item): item is EvidenceItem & { run_id: string } =>
      item.kind === 'proposal' &&
      item.run_id !== null &&
      (runId === undefined || item.run_id === runId),
  );
  const item = proposals.at(-1);
  if (!item)
    throw new EvidencePackError('proposal_not_found', 'no proposal for this intent or run');
  if (item.purged_at !== null) {
    throw new EvidencePackError('proposal_purged', 'the proposal was purged');
  }
  const size = Number(item.size_bytes);
  // The store's per-item cap, and at most PROPOSAL_MAX_BYTES (one JSON answer).
  if (size > Math.min(deps.maxItemBytes, PROPOSAL_MAX_BYTES)) {
    throw new EvidencePackError('evidence_too_large', `proposal ${item.id} is over the cap`);
  }
  let reason: CheckFailure | undefined;
  let content: Buffer = Buffer.alloc(0);
  try {
    content = await deps.store.get(item.storage_uri, { maxBytes: size });
    if (content.length !== size) reason = 'size_mismatch';
    else if (createHash('sha256').update(content).digest('hex') !== item.sha256) {
      reason = 'hash_mismatch';
    }
  } catch (error) {
    if (error instanceof EvidenceError && error.code === 'not_found') reason = 'missing';
    // Larger than the row says: the object changed.
    else if (error instanceof EvidenceError && error.code === 'too_large') reason = 'size_mismatch';
    else throw new EvidencePackError('evidence_unavailable', 'the evidence store cannot be read');
  }
  if (reason !== undefined) {
    await scope.audit.append({
      action: 'evidence.check_failed',
      actorType: 'human',
      actorId: actor.userId,
      entityId: item.id,
      occurredAt: deps.now(),
      payload: { intent_id: intent.id, kind: item.kind, reason },
    });
    throw new EvidencePackError(FAILURE_CODE[reason], `proposal ${item.id}: ${reason}`);
  }
  await scope.audit.append({
    action: 'evidence.proposal_read',
    actorType: 'human',
    actorId: actor.userId,
    entityId: item.id,
    occurredAt: deps.now(),
    payload: {
      intent_id: intent.id,
      run_id: item.run_id,
      sha256: item.sha256,
      size_bytes: size,
    },
  });
  return { intentCode: intent.code, item, content };
}
