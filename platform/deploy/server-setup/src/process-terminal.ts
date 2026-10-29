// The process's terminal for `pnpm server:setup` (D-08 V16 AC2): the only place that writes to the
// screen and reads the keyboard. Only `main.ts` uses it, after `terminalRefusal`; the step code and
// the tests use the `Terminal` interface, so they never load the CLI package.
import { InputAbortedError, readHiddenLine } from '@sdlc/cli';
import { t, type MessageKey, type MessageParams } from '@sdlc/messages';

import { CLEAR_SCREEN, PromptAborted, type Terminal } from './terminal.js';

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
