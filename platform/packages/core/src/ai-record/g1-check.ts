// The project AI record check at the submit, Draft → G1 (D-02 FR-19, D-08 B12 AC2, D-03 section 6
// "submit (AI record checked)", QUESTIONS.md #89 and #106, design/ADR-M32 §2.5).
//
// The intent workflow calls this under the intent lock, before the move to G1. When the record is
// missing or does not allow the intent's data class:
// - the intent stays `draft` and the workflow waits (`waiting: ai_record`); it is woken when the
//   record is saved (the API) or by the reconcile loop;
// - once per distinct cause, a system `fail` decision at G1 records the reason code
//   (`ai_record_missing`, `data_class_not_allowed`), bound to the intent's G1 input and the record
//   version it saw; and one status notice mentions the roles that write the record.
// Waking again with the same cause records nothing new.
// The record row is not locked: a save that commits during this check is read by the next wake
// (the API wakes the drafts after every save). At worst one extra refusal names the older version.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import type { GateReasonCode } from '@sdlc/contracts';

import { intentInputSha256 } from '../commands/gate-input.js';
import type { Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { Registry } from '../registry/registry.js';
import { aiRecordRefusal } from './rules.js';
import { loadAiRecordFacts } from './service.js';

/**
 * Null when the intent may enter G1. Otherwise the reason code, after recording the refusal
 * (once per cause).
 */
export async function checkAiRecordAtSubmit(
  tx: TenantScope,
  registry: Registry,
  intent: Intent,
): Promise<GateReasonCode | null> {
  const facts = await loadAiRecordFacts(tx, intent.project_id);
  const reason = aiRecordRefusal(facts, intent.data_class);
  if (reason === null) return null;

  const inputSha256 = createHash('sha256')
    .update(
      canonicalJson({
        v: 1,
        intent_sha256: intentInputSha256(intent),
        ai_record_sha256: facts?.recordSha256 ?? null,
        reason,
      }),
      'utf8',
    )
    .digest('hex');
  const recorded = (await tx.gateDecisions.listForIntent(intent.id, 'G1')).some(
    (d) => d.decision === 'fail' && d.input_sha256 === inputSha256,
  );
  if (recorded) return reason;

  const decision = await registry.decide(tx, {
    intentId: intent.id,
    gate: 'G1',
    decision: 'fail',
    actor: { type: 'system' },
    source: 'workflow',
    reasonCode: reason,
    inputSha256,
  });
  const { config } = await registry.policyFor(tx, intent.project_id);
  await tx.intentNotices.record({
    intentId: intent.id,
    kind: 'ai_record_refused',
    status: intent.status,
    gate: 'G1',
    previousGate: null,
    decisionId: decision.id,
    audienceRoles: config.access.ai_record_write_roles.filter((role) => role !== 'viewer'),
  });
  return reason;
}
