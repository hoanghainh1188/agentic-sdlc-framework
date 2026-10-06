// E07 AC4 (`pnpm test:agent-api`, owner only, never in CI; Harry, review of PR #161): the LiteLLM
// master key of the development stack, read once from the configuration the OpenBao Agent sidecar
// rendered into LiteLLM's tmpfs. The rendered configuration also holds the provider keys, so:
// - nothing here logs or prints it, and it is never kept: only the master key leaves this module,
//   as `Redacted`;
// - errors carry a fixed message and no cause. A failed `docker exec` throws an error whose
//   `stdout`, `stderr` and message may hold the configuration; it is dropped, never re-thrown or
//   attached, so a test runner cannot print it.
// Unit test: `platform/tests/agent/litellm-master-key.test.ts`.
import { execFileSync } from 'node:child_process';

import { Redacted } from '@sdlc/secrets';

/** Reads a file inside a container (`docker exec <container> cat <file>`). */
export type ContainerFileReader = (container: string, file: string) => string;

export const RENDERED_CONFIG = '/run/litellm/config.yaml';

/** The real reader: output captured, never inherited by the terminal. */
export const dockerExecCat: ContainerFileReader = (container, file) =>
  execFileSync('docker', ['exec', container, 'cat', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const MASTER_KEY_LINE = /^\s*master_key:\s*"?(sk-[^"\s]+)"?\s*$/m;

/** Thrown with fixed texts only: never a value, a configuration line or a cause. */
export class MasterKeyReadError extends Error {
  constructor(reason: 'unreadable' | 'missing') {
    super(
      reason === 'unreadable'
        ? `cannot read LiteLLM's rendered configuration (${RENDERED_CONFIG}): is the dev stack running with the profile models?`
        : 'LiteLLM runs without a rendered master key: start the dev stack with the profile `models`',
    );
    this.name = 'MasterKeyReadError';
  }
}

/** The master key of the running LiteLLM `container`, from its rendered configuration. */
export function readRenderedMasterKey(
  container: string,
  read: ContainerFileReader = dockerExecCat,
): Redacted {
  let config: string;
  try {
    config = read(container, RENDERED_CONFIG);
  } catch {
    // The caught error may hold the configuration (stdout) or a key in its message: drop it.
    throw new MasterKeyReadError('unreadable');
  }
  const value = MASTER_KEY_LINE.exec(config)?.[1];
  if (!value) throw new MasterKeyReadError('missing');
  return new Redacted(value);
}
