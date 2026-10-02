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
    const finish = (error?: Error): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003' || char === '\u0004') return finish(new InputAbortedError());
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
        if (value.length > MAX_SECRET_INPUT) return finish(new InputAbortedError());
      }
    };
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
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
