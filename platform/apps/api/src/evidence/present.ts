// JSON of the Evidence Pack endpoints (task E02, ADR-M48 §2.6). Codes, hashes, URIs, sizes and
// times only; the file endpoint returns the file's text with its hash, so the CLI can check it.
import type { EvidencePack } from '@sdlc/core';

export function presentPack(intentCode: string, pack: EvidencePack): Record<string, unknown> {
  return {
    intent: intentCode,
    id: pack.id,
    version: pack.version,
    content_sha256: pack.content_sha256,
    manifest: {
      uri: pack.manifest_uri,
      sha256: pack.manifest_sha256,
      size_bytes: Number(pack.manifest_size_bytes),
    },
    markdown: {
      uri: pack.markdown_uri,
      sha256: pack.markdown_sha256,
      size_bytes: Number(pack.markdown_size_bytes),
    },
    locale: pack.locale,
    disclosure_format: pack.disclosure_format,
    item_count: pack.item_count,
    built_by: pack.built_by,
    built_at: pack.created_at.toISOString(),
    sealed_at: pack.sealed_at?.toISOString() ?? null,
    retention_hold: pack.retention_hold,
    purged_at: pack.purged_at?.toISOString() ?? null,
  };
}
