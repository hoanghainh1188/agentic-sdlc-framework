// An in-memory evidence store for the tests on PostgreSQL (E02, E03): keys as SeaweedFS holds
// them (`<prefix><tenant>/<path>`); the store's own prefix is `packs/`; a taken key is refused.
import crypto from 'node:crypto';

import {
  EvidenceError,
  type EvidenceGetOptions,
  type EvidenceStore,
  type StoredEvidence,
} from '@sdlc/contracts';

export const sha256 = (bytes: Buffer): string =>
  crypto.createHash('sha256').update(bytes).digest('hex');

export class MemoryEvidenceStore implements EvidenceStore {
  readonly objects = new Map<string, Buffer>();
  puts = 0;

  put(tenantId: string, path: string, content: Buffer): Promise<StoredEvidence> {
    const key = `packs/${tenantId}/${path}`;
    if (this.objects.has(key)) return Promise.reject(new EvidenceError('exists'));
    this.objects.set(key, Buffer.from(content));
    this.puts += 1;
    return Promise.resolve({
      uri: `s3://evidence/${key}`,
      sha256: sha256(content),
      sizeBytes: content.length,
    });
  }

  get(uri: string, options: EvidenceGetOptions = {}): Promise<Buffer> {
    const body = this.objects.get(uri.slice('s3://evidence/'.length));
    if (!body) return Promise.reject(new EvidenceError('not_found'));
    if (options.maxBytes !== undefined && body.length > options.maxBytes) {
      return Promise.reject(new EvidenceError('too_large'));
    }
    return Promise.resolve(body);
  }

  /** The text of a stored file, by URI. */
  text(uri: string): string {
    return this.objects.get(uri.slice('s3://evidence/'.length))?.toString('utf8') ?? '';
  }
}
