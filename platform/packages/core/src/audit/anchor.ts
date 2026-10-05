// The daily audit anchor (task E05 PR 2, design/ADR-M51 §2.9; D-05 §7.4). Pure functions: the
// anchor document, its key, its strict parse, and the comparison with the chain.
//
// One anchor per tenant and UTC day, at `<tenant id>/<YYYY-MM-DD>.json` in the bucket
// `audit-anchors` (object lock COMPLIANCE): the RFC 8785 canonical JSON of
// `{anchored_at, hash, hash_version, seq, tenant_id}` of the tenant's last audit row. If someone
// with database access rewrites a whole chain (`sdlc audit verify` then passes), an older anchor
// no longer matches the row at its `seq`.
import { canonicalJson } from '@sdlc/config';

/** The largest anchor file read back; an anchor is about 200 bytes. */
export const MAX_ANCHOR_BYTES = 1024;
/**
 * The least lock a new anchor must carry: COMPLIANCE until at least `anchored_at` + this. The
 * bucket default is 731 days (`seaweedfs-init`); one day of margin for the store's clock.
 */
export const ANCHOR_MIN_LOCK_DAYS = 730;
const DAY_MS = 86_400_000;

export const ANCHOR_MISMATCH_REASONS = [
  /** The row at the anchor's `seq` has another hash: the chain was rewritten. */
  'hash_mismatch',
  /** No row at the anchor's `seq`: the chain shrank. */
  'seq_missing',
  /** The file is not a well-formed anchor of this tenant and date. */
  'anchor_invalid',
  /** The key has more than one version, or a delete marker: someone wrote over it. */
  'anchor_versions',
] as const;
export type AnchorMismatchReason = (typeof ANCHOR_MISMATCH_REASONS)[number];

export interface AuditAnchor {
  readonly tenantId: string;
  readonly seq: number;
  readonly hash: string;
  readonly hashVersion: number;
  readonly anchoredAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEY = /^([0-9a-f-]{36})\/(\d{4}-\d{2}-\d{2})\.json$/;
const FIELDS = ['anchored_at', 'hash', 'hash_version', 'seq', 'tenant_id'];

/** The UTC date of a time, `YYYY-MM-DD`: the day an anchor belongs to. */
export function anchorDate(time: Date): string {
  return time.toISOString().slice(0, 10);
}

/** `<tenant id>/<YYYY-MM-DD>.json`. */
export function anchorKey(tenantId: string, time: Date): string {
  return `${tenantId}/${anchorDate(time)}.json`;
}

/** The date part of a key, or null when the key is not an anchor key. */
export function dateOfAnchorKey(key: string): string | null {
  return KEY.exec(key)?.[2] ?? null;
}

/** The stored bytes: RFC 8785 canonical JSON, UTF-8. */
export function anchorBytes(anchor: AuditAnchor): Buffer {
  return Buffer.from(
    canonicalJson({
      anchored_at: anchor.anchoredAt.toISOString(),
      hash: anchor.hash,
      hash_version: anchor.hashVersion,
      seq: anchor.seq,
      tenant_id: anchor.tenantId,
    }),
    'utf8',
  );
}

/**
 * Parses an anchor file found under `tenantId`'s folder at `key`. Strict: exactly the five fields
 * with their formats, the tenant of the folder, the date of the key, and the bytes in canonical
 * form. Anything else is null (`anchor_invalid`).
 */
export function parseAnchor(bytes: Buffer, tenantId: string, key: string): AuditAnchor | null {
  const match = KEY.exec(key);
  if (!match || match[1] !== tenantId) return null;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (Object.keys(doc).sort().join(',') !== FIELDS.join(',')) return null;
  const { anchored_at: at, hash, hash_version: version, seq, tenant_id: tenant } = doc;
  if (
    typeof at !== 'string' ||
    !ISO_MS.test(at) ||
    typeof hash !== 'string' ||
    !SHA256.test(hash) ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    typeof tenant !== 'string' ||
    !UUID.test(tenant) ||
    tenant !== tenantId
  ) {
    return null;
  }
  const anchoredAt = new Date(at);
  if (Number.isNaN(anchoredAt.getTime()) || anchoredAt.toISOString() !== at) return null;
  if (anchorDate(anchoredAt) !== match[2]) return null;
  const anchor: AuditAnchor = { tenantId, seq, hash, hashVersion: version, anchoredAt };
  return anchorBytes(anchor).equals(bytes) ? anchor : null;
}

/** True when a new anchor's lock is the one `seaweedfs-init` sets (COMPLIANCE, long enough). */
export function anchorLockHolds(
  retention: { readonly mode: string; readonly until: Date } | null,
  anchoredAt: Date,
): boolean {
  return (
    retention !== null &&
    retention.mode === 'COMPLIANCE' &&
    retention.until.getTime() >= anchoredAt.getTime() + ANCHOR_MIN_LOCK_DAYS * DAY_MS
  );
}

/** The comparison of one anchor with the chain: null when it matches. */
export function compareAnchor(
  anchor: AuditAnchor,
  hashes: ReadonlyMap<number, string>,
): AnchorMismatchReason | null {
  const stored = hashes.get(anchor.seq);
  if (stored === undefined) return 'seq_missing';
  return stored === anchor.hash ? null : 'hash_mismatch';
}
