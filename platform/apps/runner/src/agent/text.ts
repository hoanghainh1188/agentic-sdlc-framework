// Cleaning and capping text written by people before it reaches the agent's prompt: the feedback
// of a request for changes (E01 PR 2) and the task text of a plan file (B09 PR 2). Shared, so both
// blocks drop the same characters.

// C0 controls except tab and line feed, DEL, C1 controls, bidirectional controls, and invisible
// characters that can hide text from a person but not from a model: zero-width characters, line
// and paragraph separators, word joiners and invisible operators, the byte-order mark, and Unicode
// tag characters (review of E01 PR 2). Written as escapes, so the source holds no invisible text.
const UNSAFE = new RegExp(
  '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f' +
    '\\u2028-\\u202f\\u2060-\\u206f\\ufeff\\u{e0000}-\\u{e007f}]',
  'gu',
);

/** Line ends normalised to `\n`, unsafe characters replaced by a space, trimmed. */
export function cleanText(raw: string): string {
  return raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(UNSAFE, ' ').trim();
}

/**
 * Cuts `text` to at most `max` characters, the `note` included at the end when cut. Never ends on
 * half of a surrogate pair.
 */
export function capText(
  text: string,
  max: number,
  note: string,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, Math.max(0, max - note.length));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: `${cut}${note}`, truncated: true };
}
