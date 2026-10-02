// Evidence items (design/D-05 section 6.6, D-08 C06 session 2b, design/ADR-M33 §2.9). A row names
// one evidence file in the evidence store with its kind, URI, SHA-256 and size; the file stays in
// SeaweedFS. Written once; the purge (E05) will set `purged_at` and keep the row.
import { EVIDENCE_KINDS, type EvidenceKind } from '@sdlc/contracts';

import { DbError } from '../errors.js';
import type { EvidenceItem } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

export interface NewEvidenceItem {
  readonly intentId: string;
  readonly runId: string | null;
  readonly kind: EvidenceKind;
  readonly storageUri: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

const URI = /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9._/-]+$/;

function invalid(field: string): never {
  throw new DbError('invalid_value', `evidence item: ${field} is not valid`);
}

export class EvidenceItemRepository extends TenantRepository {
  async record(item: NewEvidenceItem): Promise<EvidenceItem> {
    if (!isUuid(item.intentId)) invalid('intentId');
    if (item.runId !== null && !isUuid(item.runId)) invalid('runId');
    if (!(EVIDENCE_KINDS as readonly string[]).includes(item.kind)) invalid('kind');
    const uri = item.storageUri;
    if (uri.length > 700 || !URI.test(uri) || /\/\.\.?(\/|$)/.test(uri)) invalid('storageUri');
    if (!/^[0-9a-f]{64}$/.test(item.sha256)) invalid('sha256');
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) invalid('sizeBytes');
    return this.run(
      this.db
        .insertInto('evidence_items')
        .values({
          tenant_id: this.tenantId,
          intent_id: item.intentId,
          run_id: item.runId,
          kind: item.kind,
          storage_uri: item.storageUri,
          sha256: item.sha256,
          size_bytes: item.sizeBytes,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Evidence items of one intent, oldest first. */
  listForIntent(intentId: string): Promise<EvidenceItem[]> {
    if (!isUuid(intentId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('evidence_items')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
  }
}
