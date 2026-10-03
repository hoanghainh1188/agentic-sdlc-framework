// Output of the user commands (D-08 B04 AC2, design/ADR-M36 §2.4). Human text comes from the
// message catalog only. Values that come from the server (titles, slugs, messages) are cleaned of
// control and bidirectional-override characters first, so a crafted intent title cannot send
// escape sequences to the terminal. `--json` prints the validated body.
import { t, type MessageKey, type MessageParams } from '@sdlc/messages';

import type { CliContext } from './context.js';

// C0 and C1 control characters, DEL, and Unicode bidirectional controls.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One line of server text: unsafe characters become a space. */
export function clean(value: string): string {
  return value.replace(UNSAFE, ' ');
}

/** Prints a catalog message; every parameter is cleaned. */
export function say(ctx: CliContext, key: MessageKey, params: MessageParams = {}): void {
  ctx.stdout(t(key, cleanParams(params)));
}

export function sayError(ctx: CliContext, key: MessageKey, params: MessageParams = {}): void {
  ctx.stderr(t(key, cleanParams(params)));
}

/** JSON for `--json`. `JSON.stringify` escapes C0 controls; C1 and bidi controls are escaped too. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** A value for a message: `-` when empty. */
export function show(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '-' : String(value);
}

function cleanParams(params: MessageParams): MessageParams {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      typeof value === 'string' ? clean(value) : value,
    ]),
  );
}
