// The terminal of `pnpm server:setup` (D-08 V16 AC2): the only place that writes to the screen and
// reads the keyboard. Key shares are shown here only, one holder at a time; after each holder
// confirms the copy, the screen AND its scroll-back are cleared (QUESTIONS #616 (b)). The command
// refuses to run when stdin or stdout is not a terminal, so a share or a prompt never goes to a
// file or a pipe.
import { InputAbortedError, readHiddenLine } from '@sdlc/cli';
import { t, type MessageKey, type MessageParams } from '@sdlc/messages';

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

async function hiddenLine(prompt: string): Promise<string> {
  try {
    return await readHiddenLine(prompt);
  } catch (error) {
    if (error instanceof InputAbortedError) throw new PromptAborted();
    throw error;
  }
}

/** The process's terminal. Only `main.ts` builds it, after `terminalRefusal`. */
export function processTerminal(): Terminal {
  const line = (key: MessageKey, params?: MessageParams) => `${t(key, params)}\n`;
  return {
    say: (key, params) => process.stdout.write(line(key, params)),
    warn: (key, params) => process.stderr.write(line(key, params)),
    print: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    hidden: (key, params) => hiddenLine(`${t(key, params)} `),
    pause: async (key, params) => {
      await hiddenLine(`${t(key, params)} `);
    },
    showSecret: (text) => process.stdout.write(`\n    ${text}\n\n`),
    clear: () => process.stdout.write(CLEAR_SCREEN),
  };
}
