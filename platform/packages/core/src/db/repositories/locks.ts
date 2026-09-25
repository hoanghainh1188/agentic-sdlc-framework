// Transaction-scoped advisory locks of the registry (ADR-M20). Each is a fragment without a table
// reference, so it passes the tenant guard (ADR-M09 section 2.4). Lock order is always: intent
// codes or intent first, then the audit chain (audit-log.ts); so two writers never deadlock.
import { sql, type Kysely } from 'kysely';

import type { Database } from '../schema.js';
import type { TenantId } from '../tenant-id.js';

/** First keys of the two-key advisory locks. The second key is `hashtext(<id>)`. */
const INTENT_CODE_LOCK_CLASS = 0x49_4e_54_01;
const INTENT_LOCK_CLASS = 0x49_4e_54_02;

async function lock(db: Kysely<Database>, lockClass: number, key: string): Promise<void> {
  await db
    .selectNoFrom(
      sql<null>`pg_advisory_xact_lock(${lockClass}::int4, hashtext(${key}))`.as('locked'),
    )
    .execute();
}

/** Serialises intent code numbering within the tenant, until the transaction ends. */
export function lockIntentCodes(db: Kysely<Database>, tenantId: TenantId): Promise<void> {
  return lock(db, INTENT_CODE_LOCK_CLASS, tenantId);
}

/** Serialises writes about one intent (spec and plan versions, gate decisions). */
export function lockIntent(db: Kysely<Database>, intentId: string): Promise<void> {
  return lock(db, INTENT_LOCK_CLASS, intentId);
}
