// Runs one allowed command (`commands.ts`) for `pnpm doctor`: stdin empty, output captured and
// capped, never shown. A command `isAllowed` refuses is never started.
import { spawn } from 'node:child_process';

import { isAllowed } from './commands.js';

export interface ExecResult {
  /** null: the command could not start, or it was refused. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type Exec = (
  argv: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<ExecResult>;

/** Output kept per stream; the rest is dropped (logs can be large). */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const EXEC_TIMEOUT_MS = 60_000;

export function createExec(scripts: { bootstrap: string; images: string }): Exec {
  return (argv, env = {}) => {
    if (!isAllowed(argv, scripts)) {
      return Promise.resolve({ status: null, stdout: '', stderr: 'refused' });
    }
    return new Promise((resolve) => {
      // Without COMPOSE_PROJECT_NAME of the shell: the command names the project itself.
      const inherited = { ...process.env };
      delete inherited.COMPOSE_PROJECT_NAME;
      const [cmd, ...args] = argv;
      const child = spawn(cmd ?? '', args, {
        env: { ...inherited, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: EXEC_TIMEOUT_MS,
      });
      const collect = () => {
        const chunks: Buffer[] = [];
        let size = 0;
        return {
          add: (d: Buffer) => {
            if (size >= MAX_OUTPUT_BYTES) return;
            chunks.push(d);
            size += d.length;
          },
          text: () => Buffer.concat(chunks).toString('utf8'),
        };
      };
      const out = collect();
      const err = collect();
      child.stdout.on('data', out.add);
      child.stderr.on('data', err.add);
      child.on('error', () => resolve({ status: null, stdout: '', stderr: '' }));
      child.on('close', (status) => resolve({ status, stdout: out.text(), stderr: err.text() }));
    });
  };
}
