// Child processes of a deployment (`trial:up`, `server:setup`): stdin from memory, stdout and
// stderr captured, never inherited, so nothing a tool prints reaches the terminal unredacted.
import { spawn } from 'node:child_process';

export interface ExecResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly input?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * A new session without a controlling terminal, so the child cannot open `/dev/tty` and reads
   * its secrets from stdin (`bootstrap.sh api-github-oauth-credentials`, D-08 V16).
   */
  readonly detached?: boolean;
}

export type Exec = (
  cmd: string,
  args: readonly string[],
  opts?: ExecOptions,
) => Promise<ExecResult>;

/** Runs a command with stdin from `input`; stdout and stderr are captured, never shown. */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise<ExecResult>((resolve) => {
    // Without COMPOSE_PROJECT_NAME of the shell: Compose would prefer it to the env file's.
    const inherited = { ...process.env };
    delete inherited.COMPOSE_PROJECT_NAME;
    const child = spawn(cmd, args, {
      env: { ...inherited, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: opts.detached === true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => resolve({ status: null, stdout: '', stderr: e.message }));
    child.on('close', (status) =>
      resolve({
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
  });
