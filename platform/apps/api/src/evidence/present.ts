// JSON of the Evidence Pack endpoints (task E02, ADR-M48 §2.6). Codes, hashes, URIs, sizes and
// times only; the file endpoint returns the file's text with its hash, so the CLI can check it.
import type { EvidencePack } from '@sdlc/core';

export function presentPack(intentCode: string, pack: EvidencePack): Record<string, unknown> {
  return {
    intent: intentCode,
    id: pack.id,
    version: pack.version,
    content_sha256: pack.content_sha256,
    // E03 (ADR-M49 §2.2): what a G8 approval is bound to; null for packs built before E03.
    release_sha256: pack.release_sha256,
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

/**
 * C13 (ADR-M64 §2.1): an L1 run's patch, checked by core before it is served. Base64, because a
 * patch is bytes (a file in Shift_JIS stays as it is); the CLI checks the hash again.
 */
export function presentProposal(
  intentCode: string,
  runId: string,
  sha256: string,
  content: Buffer,
): Record<string, unknown> {
  return {
    proposal: {
      intent: intentCode,
      run_id: runId,
      media_type: 'text/x-diff',
      sha256,
      size_bytes: content.length,
      content_base64: content.toString('base64'),
    },
  };
}
