// Holds on an intent's evidence (task E05, design/ADR-M51, QUESTIONS #235; D-05 §6.6, version
// 1.33). A person puts an intent's evidence on hold (a dispute, an incident, a client request):
// held evidence is never purged, and the retention loop sets a legal hold on its files. At most
// one active hold per intent. Rows are never deleted; a release is recorded once (trigger SDA16).
import { sql } from 'kysely';

import { DbError } from '../errors.js';
import type { EvidenceHold } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

export interface NewEvidenceHold {
  readonly intentId: string;
  readonly heldBy: string;
  /** Optional `https://` link (≤ 512) to where the reason is written: never free text here. */
  readonly reasonRef: string | null;
}

const REF = /^https:\/\/[^\s]+$/;

export class EvidenceHoldRepository extends TenantRepository {
  /** Records a hold. An active hold on the intent already: `DbError('conflict')`. */
  create(hold: NewEvidenceHold): Promise<EvidenceHold> {
    if (!isUuid(hold.intentId) || !isUuid(hold.heldBy)) {
      throw new DbError('invalid_value', 'evidence hold: invalid ID');
    }
    if (hold.reasonRef !== null && (hold.reasonRef.length > 512 || !REF.test(hold.reasonRef))) {
      throw new DbError('invalid_value', 'evidence hold: reason_ref must be an https:// link');
    }
    return this.run(
      this.db
        .insertInto('evidence_holds')
        .values({
          tenant_id: this.tenantId,
          intent_id: hold.intentId,
          held_by: hold.heldBy,
          reason_ref: hold.reasonRef,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** The intent's active hold. */
  active(intentId: string): Promise<EvidenceHold | undefined> {
    if (!isUuid(intentId)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('evidence_holds')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .where('released_at', 'is', null)
        .executeTakeFirst(),
    );
  }

  /** Every hold of the intent, oldest first. */
  listForIntent(intentId: string): Promise<EvidenceHold[]> {
    if (!isUuid(intentId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('evidence_holds')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
  }

  /** Releases the active hold (once). Returns the released row, or undefined when none. */
  release(intentId: string, releasedBy: string): Promise<EvidenceHold | undefined> {
    if (!isUuid(intentId) || !isUuid(releasedBy)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .updateTable('evidence_holds')
        .set({ released_at: sql<Date>`now()`, released_by: releasedBy })
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .where('released_at', 'is', null)
        .returningAll()
        .executeTakeFirst(),
    );
  }

  /** Active holds, for the loop to set the legal hold on their files. */
  listActive(limit: number): Promise<EvidenceHold[]> {
    return this.run(
      this.db
        .selectFrom('evidence_holds')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('released_at', 'is', null)
        .orderBy('created_at')
        .limit(limit)
        .execute(),
    );
  }

  /** Released holds whose files still carry the legal hold. */
  listReleasePending(limit: number): Promise<EvidenceHold[]> {
    return this.run(
      this.db
        .selectFrom('evidence_holds')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('released_at', 'is not', null)
        .where('release_applied_at', 'is', null)
        .orderBy('released_at')
        .limit(limit)
        .execute(),
    );
  }

  /** The legal hold is on every file created before `at` (only moves forward). */
  async markApplied(id: string, at: Date): Promise<void> {
    await this.run(
      this.db
        .updateTable('evidence_holds')
        .set({ applied_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where((eb) => eb.or([eb('applied_at', 'is', null), eb('applied_at', '<', at)]))
        .execute(),
    );
  }

  /** The legal hold was taken off the files after the release (once). */
  async markReleaseApplied(id: string, at: Date): Promise<void> {
    await this.run(
      this.db
        .updateTable('evidence_holds')
        .set({ release_applied_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('released_at', 'is not', null)
        .where('release_applied_at', 'is', null)
        .execute(),
    );
  }
}
