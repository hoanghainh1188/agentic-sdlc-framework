// An in-memory `AuditAnchorStore` that behaves like the versioned, COMPLIANCE-locked bucket
// `audit-anchors` on SeaweedFS 4.48 (checked live, E05 PR 2, ADR-M51 §2.9): a put with
// `If-None-Match: *` on a key with a current version is `exists`; a plain delete leaves a delete
// marker, after which a put writes a second version; versions are never removed.
import { EvidenceError, type AuditAnchorStore, type AuditAnchorVersion } from '@sdlc/contracts';

interface Version {
  readonly versionId: string;
  /** Null: a delete marker. */
  readonly bytes: Buffer | null;
  readonly until: Date;
}

export class MemoryAnchorStore implements AuditAnchorStore {
  readonly versions = new Map<string, Version[]>();
  /** The lock mode new versions get (an admin may lower the bucket default). */
  mode: 'COMPLIANCE' | 'GOVERNANCE' = 'COMPLIANCE';
  lockDays = 731;
  /** When set, every call fails `unavailable`. */
  down = false;
  puts = 0;
  #next = 0;

  /** The store's clock: a new version is locked from this time. */
  constructor(readonly clock: () => number = Date.now) {}

  put(
    key: string,
    content: Buffer,
  ): Promise<
    { readonly outcome: 'written'; readonly versionId: string } | { readonly outcome: 'exists' }
  > {
    if (this.down) return Promise.reject(new EvidenceError('unavailable'));
    this.puts += 1;
    const list = this.versions.get(key) ?? [];
    const latest = list[list.length - 1];
    if (latest && latest.bytes !== null) return Promise.resolve({ outcome: 'exists' });
    const versionId = `v${++this.#next}`;
    list.push({
      versionId,
      bytes: Buffer.from(content),
      until: new Date(this.clock() + this.lockDays * 86_400_000),
    });
    this.versions.set(key, list);
    return Promise.resolve({ outcome: 'written', versionId });
  }

  /** What the anchor identity can do: a plain delete leaves a delete marker. */
  deleteMarker(key: string): void {
    const list = this.versions.get(key) ?? [];
    list.push({ versionId: `m${++this.#next}`, bytes: null, until: new Date(0) });
    this.versions.set(key, list);
  }

  listVersions(tenantId: string): Promise<readonly AuditAnchorVersion[]> {
    if (this.down) return Promise.reject(new EvidenceError('unavailable'));
    const found: AuditAnchorVersion[] = [];
    for (const key of [...this.versions.keys()].sort()) {
      if (!key.startsWith(`${tenantId}/`)) continue;
      for (const v of this.versions.get(key)!) {
        found.push({ key, versionId: v.versionId, deleteMarker: v.bytes === null });
      }
    }
    return Promise.resolve(found);
  }

  get(key: string, versionId: string, maxBytes: number): Promise<Buffer> {
    const v = this.versions.get(key)?.find((x) => x.versionId === versionId);
    if (!v || v.bytes === null) return Promise.reject(new EvidenceError('not_found'));
    if (v.bytes.length > maxBytes) return Promise.reject(new EvidenceError('too_large'));
    return Promise.resolve(Buffer.from(v.bytes));
  }

  retention(
    key: string,
    versionId: string,
  ): Promise<{ readonly mode: 'COMPLIANCE' | 'GOVERNANCE'; readonly until: Date } | null> {
    const v = this.versions.get(key)?.find((x) => x.versionId === versionId);
    return Promise.resolve(v ? { mode: this.mode, until: v.until } : null);
  }

  /** Writes a raw version, bypassing the If-None-Match check (a test's forged file). */
  forge(key: string, bytes: Buffer): void {
    const list = this.versions.get(key) ?? [];
    list.push({ versionId: `f${++this.#next}`, bytes, until: new Date(Date.now() + 1e12) });
    this.versions.set(key, list);
  }
}
