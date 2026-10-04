// Evidence Packs (design/D-05 section 6.6, version 1.30; D-08 E02; design/ADR-M48). A row names one
// build of an intent's pack: its version, the hashes and URIs of its two files (manifest, Markdown)
// in the evidence store. Written once; E03 seals one version, E05 purges the files.
import type { DisclosureFormat } from '@sdlc/contracts';

import { DbError } from '../errors.js';
import type { EvidencePack } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

export interface NewEvidencePack {
  readonly id: string;
  readonly intentId: string;
  readonly version: number;
  readonly contentSha256: string;
  readonly manifest: StoredPackFile;
  readonly markdown: StoredPackFile;
  readonly locale: string;
  readonly disclosureFormat: DisclosureFormat;
  readonly itemCount: number;
  /** Null when the platform builds the pack (E03 at G8). */
  readonly builtBy: string | null;
}

export interface StoredPackFile {
  readonly uri: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

const URI = /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9._/-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

function invalid(field: string): never {
  throw new DbError('invalid_value', `evidence pack: ${field} is not valid`);
}

function checkFile(file: StoredPackFile, field: string): void {
  if (file.uri.length > 700 || !URI.test(file.uri) || /\/\.\.?(\/|$)/.test(file.uri)) {
    invalid(`${field}.uri`);
  }
  if (!SHA256.test(file.sha256)) invalid(`${field}.sha256`);
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) invalid(`${field}.sizeBytes`);
}

export class EvidencePackRepository extends TenantRepository {
  /** Records a build. A taken version (a concurrent build) fails with `DbError('conflict')`. */
  async record(pack: NewEvidencePack): Promise<EvidencePack> {
    if (!isUuid(pack.id)) invalid('id');
    if (!isUuid(pack.intentId)) invalid('intentId');
    if (!Number.isSafeInteger(pack.version) || pack.version < 1) invalid('version');
    if (!SHA256.test(pack.contentSha256)) invalid('contentSha256');
    checkFile(pack.manifest, 'manifest');
    checkFile(pack.markdown, 'markdown');
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(pack.locale)) invalid('locale');
    if (!Number.isSafeInteger(pack.itemCount) || pack.itemCount < 0) invalid('itemCount');
    if (pack.builtBy !== null && !isUuid(pack.builtBy)) invalid('builtBy');
    return this.run(
      this.db
        .insertInto('evidence_packs')
        .values({
          id: pack.id,
          tenant_id: this.tenantId,
          intent_id: pack.intentId,
          version: pack.version,
          content_sha256: pack.contentSha256,
          manifest_uri: pack.manifest.uri,
          manifest_sha256: pack.manifest.sha256,
          manifest_size_bytes: pack.manifest.sizeBytes,
          markdown_uri: pack.markdown.uri,
          markdown_sha256: pack.markdown.sha256,
          markdown_size_bytes: pack.markdown.sizeBytes,
          locale: pack.locale,
          disclosure_format: pack.disclosureFormat,
          item_count: pack.itemCount,
          built_by: pack.builtBy,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Every version of an intent's pack, oldest first. */
  listForIntent(intentId: string): Promise<EvidencePack[]> {
    if (!isUuid(intentId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('evidence_packs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('version')
        .execute(),
    );
  }

  /** The latest version of an intent's pack. */
  latest(intentId: string): Promise<EvidencePack | undefined> {
    if (!isUuid(intentId)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('evidence_packs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
  }

  getVersion(intentId: string, version: number): Promise<EvidencePack | undefined> {
    if (!isUuid(intentId) || !Number.isSafeInteger(version) || version < 1) {
      return Promise.resolve(undefined);
    }
    return this.run(
      this.db
        .selectFrom('evidence_packs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .where('version', '=', version)
        .executeTakeFirst(),
    );
  }

  /** Whether a version of the intent's pack is sealed (E03): no new build after that. */
  async isSealed(intentId: string): Promise<boolean> {
    if (!isUuid(intentId)) return false;
    const row = await this.run(
      this.db
        .selectFrom('evidence_packs')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .where('sealed_at', 'is not', null)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }
}
