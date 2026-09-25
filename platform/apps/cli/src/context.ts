// What a command needs from the outside world; tests pass their own.
import { PlatformDatabase, type DatabaseConfig } from '@sdlc/core';

export interface CliContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly connect: (config: DatabaseConfig) => PlatformDatabase;
}

/** Exit codes: 0 success, 1 check failed (for example a broken audit chain), 2 usage or setup error, 3 unexpected error. */
export const EXIT = { ok: 0, failed: 1, usage: 2, error: 3 } as const;

export function processContext(): CliContext {
  return {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    connect: (config) => PlatformDatabase.connect(config),
  };
}
