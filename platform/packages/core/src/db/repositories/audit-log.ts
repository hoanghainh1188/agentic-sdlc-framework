// Append-only audit log (design/D-05 sections 6.7 and 7, D-08 A07, ADR-M09 section 2.8).
// Rows are only inserted. The database refuses UPDATE, DELETE and TRUNCATE (triggers and grants),
// and refuses a row that does not follow the tenant's last row (chain link trigger).
import { canonicalJson } from '@sdlc/config';
import { ACTOR_TYPES, type ActorType } from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import {
  checkAuditEvent,
  MAX_AUDIT_PAYLOAD_BYTES,
  type AuditAction,
  type AuditPayload,
} from '../../audit/actions.js';
import {
  AUDIT_HASH_VERSION,
  GENESIS_HASH,
  INITIAL_CHAIN_STATE,
  recordHash,
  stepChain,
  type ChainState,
  type StoredChainRecord,
} from '../../audit/hash-chain.js';
import { DbError } from '../errors.js';
import type { AuditLogRow, Database } from '../schema.js';
import { isUuid, type TenantId } from '../tenant-id.js';
import { TenantRepository } from './base.js';

/**
 * First key of the two-key advisory lock that serialises audit writes per tenant (D-05 7.1).
 * The second key is `hashtext(tenant_id)`. Two tenants with the same hash only wait for each other.
 */
const AUDIT_LOCK_CLASS = 0x41_55_44_01;
const VERIFY_BATCH_SIZE = 1000;

export interface AuditEvent<A extends AuditAction = AuditAction> {
  readonly action: A;
  /** `human` and `agent` need `actorId`; `system` has none. */
  readonly actorType: ActorType;
  readonly actorId: string | null;
  /** Required when the action declares an entity type (see `AUDIT_ACTIONS`); null otherwise. */
  readonly entityId: string | null;
  /** Only the declared fields: IDs, codes, hashes, versions. Never personal or client data. */
  readonly payload: AuditPayload<A>;
  /** Default: now. Stored with millisecond precision. */
  readonly occurredAt?: Date;
}

/** The last row of a tenant's chain (E05 PR 2). */
export interface AuditChainHead {
  readonly seq: number;
  readonly hash: string;
  readonly hashVersion: number;
}

export class AuditLogRepository extends TenantRepository {
  /**
   * Appends one event to the tenant's chain. Runs inside the caller's transaction when there is
   * one, so the event commits or rolls back with the change it records.
   */
  // async: an invalid event rejects the promise instead of throwing synchronously.
  async append<A extends AuditAction>(event: AuditEvent<A>): Promise<AuditLogRow> {
    const prepared = prepare(event);
    return await this.run(this.transactional((db) => appendIn(db, this.tenantId, prepared)));
  }

  /**
   * The events of one entity, in chain order (`seq`), optionally only some actions. The chain is
   * written under the tenant's audit lock, so `seq` orders the events exactly as they committed;
   * the intent workflow reads its gate history this way (task B07, ADR-M30 §2.4).
   */
  listForEntity(entityId: string, actions?: readonly AuditAction[]): Promise<AuditLogRow[]> {
    if (!isUuid(entityId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('audit_log')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('entity_id', '=', entityId)
        .$if(actions !== undefined, (qb) => qb.where('action', 'in', [...actions!]))
        .orderBy('seq')
        .execute(),
    );
  }

  /**
   * The tenant's last committed row: what the daily audit anchor records (E05 PR 2, D-05 §7.4).
   * Null when the tenant has no audit row yet.
   */
  async latest(): Promise<AuditChainHead | null> {
    const row = await this.run(
      this.db
        .selectFrom('audit_log')
        .select(['seq', 'hash', 'hash_version'])
        .where('tenant_id', '=', this.tenantId)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
    return row ? { seq: toSeq(row.seq), hash: row.hash, hashVersion: row.hash_version } : null;
  }

  /**
   * The stored `hash` of each of these rows, by `seq` (E05 PR 2: the anchors are compared with
   * them). A `seq` without a row is missing from the map. In pages of `VERIFY_BATCH_SIZE`.
   */
  async hashesAt(seqs: readonly number[]): Promise<Map<number, string>> {
    const wanted = [...new Set(seqs)].filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const found = new Map<number, string>();
    for (let i = 0; i < wanted.length; i += VERIFY_BATCH_SIZE) {
      const page = wanted.slice(i, i + VERIFY_BATCH_SIZE).map(String);
      const rows = await this.run(
        this.db
          .selectFrom('audit_log')
          .select(['seq', 'hash'])
          .where('tenant_id', '=', this.tenantId)
          .where('seq', 'in', page)
          .execute(),
      );
      for (const row of rows) found.set(toSeq(row.seq), row.hash);
    }
    return found;
  }

  /** Reads the tenant's chain in `seq` order and checks it (D-05 section 7.3, FR-41). */
  async verify(batchSize: number = VERIFY_BATCH_SIZE): Promise<ChainState> {
    let state = INITIAL_CHAIN_STATE;
    for (;;) {
      const rows = await this.run(
        this.db
          .selectFrom('audit_log')
          .selectAll()
          .where('tenant_id', '=', this.tenantId)
          .where('seq', '>', String(state.lastSeq))
          .orderBy('seq')
          .limit(batchSize)
          .execute(),
      );
      for (const row of rows) {
        state = stepChain(state, toChainRecord(row));
        if (state.broken) return state;
      }
      if (rows.length < batchSize) return state;
    }
  }
}

interface PreparedEvent {
  readonly action: string;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly payload: Record<string, unknown>;
  readonly payloadJson: string;
  readonly occurredAt: Date;
}

function prepare(event: AuditEvent): PreparedEvent {
  if (!ACTOR_TYPES.includes(event.actorType)) throw invalid('unknown actor type');
  if (event.actorType === 'system' ? event.actorId !== null : !isUuid(event.actorId)) {
    throw invalid(`actor ID must be ${event.actorType === 'system' ? 'null' : 'a UUID'}`);
  }
  const { entityType, payload } = checkAuditEvent(event.action, event.entityId, event.payload);
  const payloadJson = canonicalJson(payload);
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_AUDIT_PAYLOAD_BYTES) {
    throw invalid(`payload larger than ${MAX_AUDIT_PAYLOAD_BYTES} bytes`);
  }
  const occurredAt = new Date(event.occurredAt ?? Date.now());
  if (Number.isNaN(occurredAt.getTime())) throw invalid('occurredAt is not a valid date');
  return {
    action: event.action,
    actorType: event.actorType,
    actorId: event.actorId,
    entityType,
    entityId: event.entityId,
    payload,
    payloadJson,
    occurredAt,
  };
}

/**
 * Inside a transaction: lock the tenant's chain, read its tail, hash and insert.
 * Relies on READ COMMITTED (the PostgreSQL default, used everywhere in the platform): the tail
 * read after the lock sees the row the previous lock holder committed. Under a stricter isolation
 * level the snapshot could be older, and the chain link trigger would refuse the insert (SDA02).
 */
async function appendIn(
  db: Kysely<Database>,
  tenantId: TenantId,
  event: PreparedEvent,
): Promise<AuditLogRow> {
  // Held until the transaction ends. A fragment without a table reference: the tenant guard
  // allows it (ADR-M09 section 2.4).
  await db
    .selectNoFrom(
      sql<null>`pg_advisory_xact_lock(${AUDIT_LOCK_CLASS}::int4, hashtext(${tenantId}))`.as(
        'locked',
      ),
    )
    .execute();
  const last = await db
    .selectFrom('audit_log')
    .select(['seq', 'hash'])
    .where('tenant_id', '=', tenantId)
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  const record = {
    hashVersion: AUDIT_HASH_VERSION,
    tenantId,
    seq: last ? toSeq(last.seq) + 1 : 1,
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    payload: event.payload,
    occurredAt: event.occurredAt,
    prevHash: last?.hash ?? GENESIS_HASH,
  };
  return db
    .insertInto('audit_log')
    .values({
      tenant_id: tenantId,
      seq: record.seq,
      hash_version: record.hashVersion,
      actor_type: record.actorType,
      actor_id: record.actorId,
      action: record.action,
      entity_type: record.entityType,
      entity_id: record.entityId,
      payload: event.payloadJson,
      prev_hash: record.prevHash,
      hash: recordHash(record),
      occurred_at: record.occurredAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

function toChainRecord(row: AuditLogRow): StoredChainRecord {
  return {
    hashVersion: row.hash_version,
    tenantId: row.tenant_id,
    seq: toSeq(row.seq),
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: row.payload,
    occurredAt: row.occurred_at,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

/** `seq` is int8, returned as a string by `pg`. */
function toSeq(value: string): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq)) throw new RangeError(`audit seq ${value} is out of range`);
  return seq;
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', `audit event: ${message}`);
}
