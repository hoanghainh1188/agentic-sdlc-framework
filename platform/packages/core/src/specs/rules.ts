// The rules of a spec file (task B08, D-02 FR-02, design/ADR-M39 §2.3, QUESTIONS #163). These are
// design, not configuration: the platform reads Markdown specs (D-01 §5.2, the spec adapter reads
// Markdown only in the MVP) and keeps only their hash; the content stays in the repository.
import { createHash } from 'node:crypto';

import { isSafeRepoPath } from '../db/repositories/spec-refs.js';

/** Largest spec file the platform hashes, in bytes (256 KiB, QUESTIONS #163). */
export const SPEC_MAX_BYTES = 256 * 1024;

/** File name endings of a spec (Markdown, compared without case). */
export const SPEC_EXTENSIONS = ['.md', '.markdown'] as const;

/** Why a spec cannot be read at a commit. Codes only. */
export const SPEC_UNREADABLE_CAUSES = ['missing', 'not_a_file', 'too_large', 'not_utf8'] as const;
export type SpecUnreadableCause = (typeof SPEC_UNREADABLE_CAUSES)[number];

/** A safe relative path to a Markdown file (no `.` or `..` segment, no trailing slash). */
export function isSpecPath(path: string): boolean {
  if (!isSafeRepoPath(path) || path.endsWith('/')) return false;
  const lower = path.toLowerCase();
  return SPEC_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

/**
 * SHA-256 of the spec's content. The Git host returns the file as strict UTF-8 text with its
 * byte-order mark kept, so this equals the SHA-256 of the file's bytes (`sha256sum <file>`).
 */
export function specContentSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
