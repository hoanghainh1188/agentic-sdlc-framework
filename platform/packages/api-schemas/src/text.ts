// Server text is external data (ADR-M36 §2.4): before it is shown, C0 and C1 control characters,
// DEL, the Unicode bidirectional controls, zero-width characters and the line and paragraph
// separators are replaced, so a crafted title cannot send escape sequences to a terminal or
// reorder or hide text on a page. Shared by the CLI and the dashboard. Every character is written
// as an escape: an editor never strips it unseen.

const UNSAFE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** One line of server text: unsafe characters become a space. */
export function cleanText(value: string): string {
  return value.replace(UNSAFE, ' ');
}
