// KV version 2 reads (mount `kv/`, ADR-M19 §2.4). Values come back wrapped in `Redacted`.
import type { SecretEntry, SecretReader } from '@sdlc/contracts';

import type { Caller } from './client.js';
import { SecretsError } from './errors.js';
import { Redacted } from './redacted.js';

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Checks a secret path: segments of letters, digits, `-`, `_`, `.`; no `.` or `..` segment. */
export function checkSecretPath(path: string): string {
  const segments = path.split('/');
  const valid = segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
  if (!valid || path.length > 512) throw new SecretsError('secrets.invalid_path', { path });
  return segments.map(encodeURIComponent).join('/');
}

export class KvReader implements SecretReader {
  constructor(
    private readonly mount: string,
    private readonly call: Caller,
  ) {}

  async read(path: string, options: { version?: number } = {}): Promise<SecretEntry> {
    const clean = checkSecretPath(path);
    const { version } = options;
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
      throw new SecretsError('secrets.invalid_version', { path });
    }
    const query = version === undefined ? '' : `?version=${version}`;
    const res = await this.call({
      operation: 'read',
      method: 'GET',
      path: `${this.mount}/data/${clean}${query}`,
      accept: [404],
    });
    // 404 also covers a deleted or destroyed version.
    if (res.status === 404) throw new SecretsError('secrets.not_found', { path });
    return parseEntry(res.body, path);
  }
}

function parseEntry(body: unknown, path: string): SecretEntry {
  const data = (body as { data?: { data?: unknown; metadata?: { version?: unknown } } } | undefined)
    ?.data;
  const fields = data?.data;
  const version = data?.metadata?.version;
  if (
    !fields ||
    typeof fields !== 'object' ||
    Array.isArray(fields) ||
    typeof version !== 'number'
  ) {
    throw new SecretsError('secrets.openbao.invalid_response', { operation: `read ${path}` });
  }
  const entries = Object.entries(fields as Record<string, unknown>).map(
    ([name, value]) =>
      [name, new Redacted(typeof value === 'string' ? value : JSON.stringify(value))] as const,
  );
  return { data: Object.freeze(Object.fromEntries(entries)), version };
}
