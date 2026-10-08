// What a command needs from the outside world; tests pass their own.
import { PlatformDatabase, type DatabaseConfig } from '@sdlc/core';

import { readHiddenLine, readAllStdin } from './credentials/prompt.js';

/** What the user commands (through the API, task B04) need besides the base context. */
export interface ApiIo {
  readonly fetch: typeof fetch;
  /** Reads one line without echoing it (the token prompt). Only called when `stdinIsTTY`. */
  readonly readHiddenLine: (prompt: string) => Promise<string>;
  /** Reads standard input to its end (`sdlc login --token-stdin`). */
  readonly readStdin: () => Promise<string>;
  readonly stdinIsTTY: boolean;
}

export interface CliContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly connect: (config: DatabaseConfig) => PlatformDatabase;
  /** Network and terminal access of the user commands. Missing: the real process (`processApiIo`). */
  readonly api?: ApiIo;
  /** The folder relative paths start from (`sdlc plan draft`). Missing: `process.cwd()`. */
  readonly cwd?: string;
}

/**
 * Exit codes: 0 success, 1 check failed or refused by the platform (for example a broken audit
 * chain, or a 403/404/409/422/429 from the API), 2 usage or setup error, 3 unexpected error,
 * 4 authentication failed (run `sdlc login`). design/ADR-M36 §2.5.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2, error: 3, auth: 4 } as const;

export function processApiIo(): ApiIo {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    readHiddenLine,
    readStdin: readAllStdin,
    stdinIsTTY: process.stdin.isTTY === true,
  };
}

export function processContext(): CliContext {
  return {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    connect: (config) => PlatformDatabase.connect(config),
    api: processApiIo(),
  };
}
