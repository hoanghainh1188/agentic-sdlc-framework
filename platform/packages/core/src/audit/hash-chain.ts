// Per-tenant audit hash chain (design/D-05 section 7, D-08 A07, ADR-M09 section 2.8).
// Pure functions, no database: the repository (db/repositories/audit-log.ts) reads and writes rows.
//
//   hash = SHA-256( prev_hash || canonical_json(record without `hash`) )
//
// `canonical_json` is RFC 8785 (JCS), shared with `config_hash` (@sdlc/config, ADR-M18). The
// hashed record holds `hash_version`, so a later change of the field list or of canonicalisation
// gets a new version and old rows still verify under their own version.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import type { ActorType } from '@sdlc/contracts';

/** The only hash version so far. A new version needs a migration (the column has a CHECK). */
export const AUDIT_HASH_VERSION = 1;
/** `prev_hash` of the first record of every tenant. */
export const GENESIS_HASH = '0'.repeat(64);

/** The hashed content of one audit record: every stored column except `id`, `hash`, `created_at`. */
export interface ChainRecord {
  readonly hashVersion: number;
  readonly tenantId: string;
  readonly seq: number;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Stored with millisecond precision, hashed as ISO 8601 UTC (`toISOString`). */
  readonly occurredAt: Date;
  readonly prevHash: string;
}

export interface StoredChainRecord extends ChainRecord {
  readonly hash: string;
}

/** The JSON document that is canonicalised and hashed, version 1. */
function hashedDocumentV1(record: ChainRecord): Record<string, unknown> {
  return {
    hash_version: record.hashVersion,
    tenant_id: record.tenantId,
    seq: record.seq,
    actor_type: record.actorType,
    actor_id: record.actorId,
    action: record.action,
    entity_type: record.entityType,
    entity_id: record.entityId,
    payload: record.payload,
    occurred_at: record.occurredAt.toISOString(),
    prev_hash: record.prevHash,
  };
}

/** Computes the hash of a record. Throws for an unknown hash version. */
export function recordHash(record: ChainRecord): string {
  if (record.hashVersion !== AUDIT_HASH_VERSION) {
    throw new RangeError(`unknown audit hash version ${record.hashVersion}`);
  }
  return createHash('sha256')
    .update(record.prevHash, 'utf8')
    .update(canonicalJson(hashedDocumentV1(record)), 'utf8')
    .digest('hex');
}

export type ChainBreakReason =
  'seq_gap' | 'prev_hash_mismatch' | 'hash_mismatch' | 'unknown_hash_version';

export interface ChainBreak {
  readonly seq: number;
  readonly reason: ChainBreakReason;
}

/** State of a chain check. `checked` counts the records that verified before any break. */
export interface ChainState {
  readonly checked: number;
  readonly lastSeq: number;
  readonly lastHash: string;
  readonly broken?: ChainBreak;
}

export const INITIAL_CHAIN_STATE: ChainState = { checked: 0, lastSeq: 0, lastHash: GENESIS_HASH };

/**
 * Checks the next record of one tenant's chain, read in ascending `seq` (D-05 section 7.3).
 * Returns a new state; once broken, the state no longer changes.
 */
export function stepChain(state: ChainState, record: StoredChainRecord): ChainState {
  if (state.broken) return state;
  const reason = breakReason(state, record);
  if (reason) return { ...state, broken: { seq: record.seq, reason } };
  return { checked: state.checked + 1, lastSeq: record.seq, lastHash: record.hash };
}

function breakReason(state: ChainState, record: StoredChainRecord): ChainBreakReason | undefined {
  if (record.seq !== state.lastSeq + 1) return 'seq_gap';
  if (record.prevHash !== state.lastHash) return 'prev_hash_mismatch';
  if (record.hashVersion !== AUDIT_HASH_VERSION) return 'unknown_hash_version';
  return recordHash(record) === record.hash ? undefined : 'hash_mismatch';
}

/** Checks a whole chain held in memory. The repository streams large chains with `stepChain`. */
export function verifyChain(records: Iterable<StoredChainRecord>): ChainState {
  let state = INITIAL_CHAIN_STATE;
  for (const record of records) {
    state = stepChain(state, record);
    if (state.broken) break;
  }
  return state;
}
