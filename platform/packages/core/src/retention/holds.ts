// Holds on an intent's evidence (task E05, design/ADR-M51, QUESTIONS #235; handbook Ch.15).
// A person puts an intent's evidence on hold for a dispute, an incident or a client request: the
// retention loop never purges it and sets a legal hold on its files in the evidence store, which
// even the purge identity cannot delete. Releasing the hold lets the normal retention apply again.
//
// - Who: tenant admins, or a role on the intent's project in config `access.evidence_hold_roles`
//   (default `governance`, `admin`; never `viewer`, mandatory rule M32). No role on the project:
//   the intent is not found; another role: forbidden.
// - At most one active hold per intent. The reason stays where it can be edited (an optional
//   `https://` link), never as text here: the hold rows are kept like the audit log.
// - Every change appends an audit event (`evidence.hold_set`, `evidence.hold_released`).
import { isTenantAdmin } from '../admin/actor.js';
import { CommandError } from '../commands/errors.js';
import { DbError } from '../db/errors.js';
import type { EvidenceHold, Intent } from '../db/schema.js';
import { isUuid } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { loadEffectiveConfig } from '../registry/effective-config.js';
import { EvidenceHoldError } from './errors.js';

export interface EvidenceHoldActor {
  readonly userId: string;
}

export interface EvidenceHoldView {
  readonly intent: Intent;
  /** The active hold, or null. */
  readonly active: EvidenceHold | null;
  /** Every hold of the intent, oldest first. */
  readonly history: readonly EvidenceHold[];
}

async function resolveIntent(
  scope: TenantScope,
  actor: EvidenceHoldActor,
  intentRef: string,
): Promise<Intent> {
  const intent = isUuid(intentRef)
    ? await scope.intents.getById(intentRef)
    : await scope.intents.getByCode(intentRef);
  if (!intent) throw new CommandError('intent_not_found', `intent ${intentRef} not found`);
  if (await isTenantAdmin(scope, actor.userId)) return intent;
  const roles = (await scope.roleBindings.listForUser(actor.userId))
    .filter((binding) => binding.project_id === intent.project_id)
    .map((binding) => binding.role);
  if (roles.length === 0) {
    throw new CommandError('intent_not_found', 'intent_not_found: no role on the project');
  }
  const { config } = await loadEffectiveConfig(scope.projectConfigs, intent.project_id);
  if (!roles.some((role) => config.access.evidence_hold_roles.includes(role))) {
    throw new CommandError('forbidden', 'no role in access.evidence_hold_roles');
  }
  return intent;
}

/** Puts the intent's evidence on hold. */
export async function holdEvidence(
  scope: TenantScope,
  actor: EvidenceHoldActor,
  intentRef: string,
  reasonRef: string | null,
): Promise<EvidenceHold> {
  return scope.transaction(async (tx) => {
    const found = await resolveIntent(tx, actor, intentRef);
    // The intent lock serialises the hold with the retention loop's purge of the same intent.
    const intent = (await tx.intents.lockAndGet(found.id)) ?? found;
    if (await tx.evidenceHolds.active(intent.id)) {
      throw new EvidenceHoldError('evidence_hold_exists', 'the evidence is on hold already');
    }
    let hold: EvidenceHold;
    try {
      hold = await tx.evidenceHolds.create({
        intentId: intent.id,
        heldBy: actor.userId,
        reasonRef,
      });
    } catch (error) {
      if (error instanceof DbError && error.code === 'conflict') {
        throw new EvidenceHoldError('evidence_hold_exists', 'the evidence is on hold already');
      }
      throw error;
    }
    await tx.audit.append({
      action: 'evidence.hold_set',
      actorType: 'human',
      actorId: actor.userId,
      entityId: intent.id,
      payload: { hold_id: hold.id },
    });
    return hold;
  });
}

/** Releases the hold on the intent's evidence. */
export async function releaseEvidenceHold(
  scope: TenantScope,
  actor: EvidenceHoldActor,
  intentRef: string,
): Promise<EvidenceHold> {
  return scope.transaction(async (tx) => {
    const found = await resolveIntent(tx, actor, intentRef);
    const intent = (await tx.intents.lockAndGet(found.id)) ?? found;
    const released = await tx.evidenceHolds.release(intent.id, actor.userId);
    if (!released) {
      throw new EvidenceHoldError('evidence_hold_not_found', 'the evidence is not on hold');
    }
    await tx.audit.append({
      action: 'evidence.hold_released',
      actorType: 'human',
      actorId: actor.userId,
      entityId: intent.id,
      payload: { hold_id: released.id },
    });
    return released;
  });
}

/** The intent's holds: the active one and the history. */
export async function showEvidenceHolds(
  scope: TenantScope,
  actor: EvidenceHoldActor,
  intentRef: string,
): Promise<EvidenceHoldView> {
  const intent = await resolveIntent(scope, actor, intentRef);
  const history = await scope.evidenceHolds.listForIntent(intent.id);
  return { intent, active: history.find((hold) => hold.released_at === null) ?? null, history };
}
