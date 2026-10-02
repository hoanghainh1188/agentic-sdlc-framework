// Reading the API token without showing it (design/ADR-M36 §2.2). The token never comes from a
// command-line argument: it would stay in the shell history and in process listings.

/** Longest input accepted: a token is 52 characters; anything much longer is a mistake. */
export const MAX_SECRET_INPUT = 1024;

export class InputAbortedError extends Error {
  constructor() {
    super('input_aborted');
  }
}

/** Reads one line from the terminal in raw mode, without echo. Ctrl-C or Ctrl-D aborts. */
export function readHiddenLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let value = '';
    let escape = false;
    let done = false;
    const abort = (): void => finish(new InputAbortedError());
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', abort);
      stdin.removeListener('error', abort);
      process.removeListener('SIGTERM', abort);
      process.removeListener('SIGHUP', abort);
      // Always give the terminal back its echo, whatever ended the prompt.
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        // Escape sequences (arrow keys, bracketed paste markers) are skipped, never kept.
        if (escape) {
          if (/[A-Za-z~]/.test(char)) escape = false;
          continue;
        }
        if (char === '\u001b') escape = true;
        else if (char === '\r' || char === '\n') return finish();
        else if (char === '\u0003' || char === '\u0004') return abort();
        else if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
        if (value.length > MAX_SECRET_INPUT) return abort();
      }
    };
    process.stderr.write(prompt);
    stdin.on('end', abort);
    stdin.on('error', abort);
    process.once('SIGTERM', abort);
    process.once('SIGHUP', abort);
    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
    } catch (error) {
      finish(error instanceof Error ? error : new InputAbortedError());
    }
  });
}

/** Reads standard input to its end, at most `MAX_SECRET_INPUT` bytes. */
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_SECRET_INPUT) throw new InputAbortedError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
