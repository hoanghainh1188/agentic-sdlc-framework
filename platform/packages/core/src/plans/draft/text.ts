// Text of a plan draft (task S02, ADR-M62 §2.3): cleaned and capped values, and the paths a task
// names, offered as comments only.
import { isAgentInstructionPath } from '@sdlc/contracts';

import { patternRefusal } from '../rules.js';
import { DRAFT_FIELD_MAX_CHARS, DRAFT_PATH_HINTS_MAX } from './types.js';

/** Control, line-separator, bidirectional-override and byte-order-mark characters. */
const UNSAFE =
  // eslint-disable-next-line no-control-regex -- control characters are what it removes
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufffe\uffff]/g;

/**
 * One line of text for a YAML value: control, line-separator and bidirectional-override characters
 * become a space, white space is collapsed, and the text is capped.
 */
export function draftText(value: string): string {
  const text = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, DRAFT_FIELD_MAX_CHARS).join('');
}

/** A path as written in a task: a slash, safe characters only, no template brackets. */
const PATH_TOKEN = /(?<![A-Za-z0-9._@/-])([A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+\/?)/g;

/**
 * The paths a task's text names (`in src/models/user.py`), for comments under `allowed_paths`.
 * Only characters that are safe in a pattern; a path submission would refuse (protected, too
 * broad, not relative) is left out, so a suggestion never points at `.github/` or `AGENTS.md`.
 */
export function pathHints(texts: readonly string[]): string[] {
  const hints = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PATH_TOKEN)) {
      const path = match[1]!.replace(/[.]+$/, '').replace(/\/$/, '');
      if (!path.includes('/') || patternRefusal(path) !== null || nestedProtected(path)) continue;
      hints.add(path);
    }
  }
  return [...hints].slice(0, DRAFT_PATH_HINTS_MAX);
}

/** A `.github` or `.sdlc` folder, or an instruction file, at any depth (`src/.github/x`). */
function nestedProtected(path: string): boolean {
  const segments = path.split('/');
  return segments.some(
    (segment, i) =>
      ['.github', '.sdlc'].includes(segment.normalize('NFC').toLowerCase()) ||
      isAgentInstructionPath(segments.slice(i).join('/')) ||
      isAgentInstructionPath(segment),
  );
}
