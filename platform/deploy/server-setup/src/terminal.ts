// The terminal of `pnpm server:setup` (D-08 V16 AC2): what the command may do with the screen and
// the keyboard; the process's own terminal is `process-terminal.ts`. Key shares are shown through
// it only, one holder at a time; after each holder confirms the copy, the screen AND its
// scroll-back are cleared (QUESTIONS #616 (b)). The command refuses to run when stdin or stdout is
// not a terminal, so a share or a prompt never goes to a file or a pipe.
import type { MessageKey, MessageParams } from '@sdlc/messages';

/**
 * Clears the scroll-back (`ESC [3J`), moves the cursor home and clears the screen (`ESC [H`,
 * `ESC [2J`). xterm, macOS Terminal and iTerm2 all honour `ESC [3J`.
 */
export const CLEAR_SCREEN = '\u001b[3J\u001b[H\u001b[2J';

/** Ctrl-C or Ctrl-D at a prompt: the person stopped the command. */
export class PromptAborted extends Error {
  constructor() {
    super('prompt_aborted');
  }
}

export interface Terminal {
  say(key: MessageKey, params?: MessageParams): void;
  warn(key: MessageKey, params?: MessageParams): void;
  /** Text already redacted (a child's output). */
  print(text: string): void;
  /** One hidden line; throws `PromptAborted` on Ctrl-C or Ctrl-D. */
  hidden(key: MessageKey, params?: MessageParams): Promise<string>;
  /** Waits for Enter; throws `PromptAborted` on Ctrl-C or Ctrl-D. */
  pause(key: MessageKey, params?: MessageParams): Promise<void>;
  /** One key share, on its own line. */
  showSecret(text: string): void;
  /** The screen and its scroll-back. */
  clear(): void;
}

/** Why the command must not run here, or undefined (AC2). Pure. */
export function terminalRefusal(
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): 'stdin_not_terminal' | 'stdout_not_terminal' | undefined {
  if (!stdoutIsTTY) return 'stdout_not_terminal';
  if (!stdinIsTTY) return 'stdin_not_terminal';
  return undefined;
}
