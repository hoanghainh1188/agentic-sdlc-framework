// D-08 A07 AC2 (pure part): per-tenant hash chain with RFC 8785 canonical JSON and SHA-256
// (design/D-05 section 7.1), and the chain check behind `sdlc audit verify` (section 7.3).
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  AUDIT_HASH_VERSION,
  GENESIS_HASH,
  recordHash,
  verifyChain,
  type ChainRecord,
  type StoredChainRecord,
} from '../../packages/core/src/audit/hash-chain.js';
import { SOME_ID, TENANT_A } from '../db/dummy.js';

const PROJECT = '0d0d0d0d-0000-4000-8000-00000000000d';

const first: ChainRecord = {
  hashVersion: AUDIT_HASH_VERSION,
  tenantId: TENANT_A,
  seq: 1,
  actorType: 'human',
  actorId: SOME_ID,
  action: 'config.changed',
  entityType: 'project',
  entityId: PROJECT,
  payload: { version: 1, config_hash: 'ab'.repeat(32) },
  occurredAt: new Date('2026-09-25T01:02:03.004Z'),
  prevHash: GENESIS_HASH,
};

/** Builds a valid chain of `n` records. */
function chain(n: number): StoredChainRecord[] {
  const records: StoredChainRecord[] = [];
  let prevHash = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const record = {
      ...first,
      seq,
      prevHash,
      payload: { version: seq, config_hash: 'ab'.repeat(32) },
    };
    const hash = recordHash(record);
    records.push({ ...record, hash });
    prevHash = hash;
  }
  return records;
}

describe('recordHash (D-05 7.1)', () => {
  it('is SHA-256 of prev_hash followed by the canonical JSON of the record (version 1 field list)', () => {
    const canonical =
      '{"action":"config.changed",' +
      `"actor_id":"${SOME_ID}","actor_type":"human",` +
      `"entity_id":"${PROJECT}","entity_type":"project",` +
      '"hash_version":1,"occurred_at":"2026-09-25T01:02:03.004Z",' +
      `"payload":{"config_hash":"${'ab'.repeat(32)}","version":1},` +
      `"prev_hash":"${GENESIS_HASH}","seq":1,"tenant_id":"${TENANT_A}"}`;
    const expected = createHash('sha256')
      .update(GENESIS_HASH + canonical)
      .digest('hex');
    expect(recordHash(first)).toBe(expected);
    // Pinned: any change to the field list or to canonicalisation needs a new hash version.
    expect(recordHash(first)).toBe(
      '551d21ca27d7f5a68ebd94d489d7b20f0ea97a83e806416f50242609dd3fedb5',
    );
  });

  it('does not depend on the key order of the payload', () => {
    const reordered = { ...first, payload: { config_hash: 'ab'.repeat(32), version: 1 } };
    expect(recordHash(reordered)).toBe(recordHash(first));
  });

  it('changes when any hashed field changes', () => {
    const base = recordHash(first);
    const variants: Partial<ChainRecord>[] = [
      { tenantId: '0b0b0b0b-0000-4000-8000-00000000000b' },
      { seq: 2 },
      { actorType: 'system', actorId: null },
      { action: 'ai_record.changed' },
      { entityId: SOME_ID },
      { payload: { version: 2, config_hash: 'ab'.repeat(32) } },
      { occurredAt: new Date('2026-09-25T01:02:03.005Z') },
      { prevHash: 'f'.repeat(64) },
    ];
    for (const variant of variants) {
      expect(recordHash({ ...first, ...variant }), JSON.stringify(variant)).not.toBe(base);
    }
  });

  it('refuses an unknown hash version', () => {
    expect(() => recordHash({ ...first, hashVersion: 2 })).toThrow(/hash version/);
  });
});

describe('verifyChain (D-05 7.3)', () => {
  it('accepts an empty chain and an intact chain', () => {
    expect(verifyChain([])).toEqual({ checked: 0, lastSeq: 0, lastHash: GENESIS_HASH });
    const records = chain(5);
    expect(verifyChain(records)).toEqual({
      checked: 5,
      lastSeq: 5,
      lastHash: records[4]!.hash,
    });
  });

  it('reports a modified record as hash_mismatch at its seq', () => {
    const records = chain(5);
    records[2] = { ...records[2]!, payload: { version: 99, config_hash: 'ab'.repeat(32) } };
    expect(verifyChain(records).broken).toEqual({ seq: 3, reason: 'hash_mismatch' });
    expect(verifyChain(records).checked).toBe(2);
  });

  it('reports a rewritten hash at the next record (prev_hash_mismatch)', () => {
    const records = chain(5);
    records[1] = { ...records[1]!, hash: 'e'.repeat(64) };
    expect(verifyChain(records).broken).toEqual({ seq: 2, reason: 'hash_mismatch' });
    const recomputed = chain(5);
    const forged = { ...recomputed[1]!, payload: { version: 42, config_hash: 'ab'.repeat(32) } };
    recomputed[1] = { ...forged, hash: recordHash(forged) };
    expect(verifyChain(recomputed).broken).toEqual({ seq: 3, reason: 'prev_hash_mismatch' });
  });

  it('reports a deleted or reordered record as seq_gap', () => {
    const records = chain(5);
    expect(verifyChain([...records.slice(0, 2), ...records.slice(3)]).broken).toEqual({
      seq: 4,
      reason: 'seq_gap',
    });
    expect(verifyChain(records.slice(1)).broken).toEqual({ seq: 2, reason: 'seq_gap' });
  });

  it('reports a first record that does not start from the genesis hash', () => {
    const [one] = chain(1);
    expect(verifyChain([{ ...one!, prevHash: 'a'.repeat(64) }]).broken).toEqual({
      seq: 1,
      reason: 'prev_hash_mismatch',
    });
  });

  it('reports an unknown hash version', () => {
    const [one] = chain(1);
    expect(verifyChain([{ ...one!, hashVersion: 7 }]).broken).toEqual({
      seq: 1,
      reason: 'unknown_hash_version',
    });
  });
});
