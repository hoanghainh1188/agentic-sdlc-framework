// OpenBao response wrapping (ADR-M25 §2.11, QUESTIONS #44). The worker wraps the run's GitHub
// token; only the single-use wrapping token travels to the runner (and into Temporal's history).
// The runner unwraps it once. If anyone else unwrapped it first, the runner's unwrap fails and the
// run is refused, so a stolen wrapping token is noticed.
import type { RedactedSecret, SecretUnwrapper, SecretWrapper } from '@sdlc/contracts';

import type { Caller } from './client.js';
import { SecretsError } from './errors.js';
import { Redacted } from './redacted.js';
import type { HttpResponse, RequestInput } from './transport.js';

type RawRequest = (method: 'POST', path: string, input: RequestInput) => Promise<HttpResponse>;

const WRAP_PATH = 'sys/wrapping/wrap';
const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
/** Wrapping tokens live at most one hour: long enough for a contract (default 15 minutes). */
export const MAX_WRAP_TTL_SECONDS = 3600;

export class Wrapping implements SecretWrapper, SecretUnwrapper {
  constructor(
    private readonly call: Caller,
    private readonly raw: RawRequest,
  ) {}

  async wrap(
    fields: Readonly<Record<string, RedactedSecret>>,
    options: { ttlSeconds: number },
  ): Promise<RedactedSecret> {
    const { ttlSeconds } = options;
    const names = Object.keys(fields);
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > MAX_WRAP_TTL_SECONDS ||
      names.length === 0 ||
      !names.every((name) => FIELD.test(name))
    ) {
      throw new SecretsError('secrets.wrapping.invalid_input');
    }
    const body = Object.fromEntries(names.map((name) => [name, fields[name]!.reveal()]));
    const res = await this.call({
      operation: 'wrap',
      method: 'POST',
      path: WRAP_PATH,
      body,
      headers: { 'X-Vault-Wrap-TTL': `${String(ttlSeconds)}s` },
    });
    const info = (res.body as { wrap_info?: Record<string, unknown> } | undefined)?.wrap_info;
    const token = info?.['token'];
    if (typeof token !== 'string' || token === '' || info?.['creation_path'] !== WRAP_PATH) {
      throw new SecretsError('secrets.openbao.invalid_response', { operation: 'wrap' });
    }
    return new Redacted(token);
  }

  async unwrap(wrappingToken: RedactedSecret): Promise<Readonly<Record<string, RedactedSecret>>> {
    const token = wrappingToken.reveal();
    // 1. The token must have been made by `sys/wrapping/wrap`: a wrapped response of another
    //    endpoint (for example a secret ID) is refused. The lookup needs no authentication and
    //    does not use the token up.
    const lookup = await this.raw('POST', 'sys/wrapping/lookup', { body: { token } });
    const creationPath = (lookup.body as { data?: { creation_path?: unknown } } | undefined)?.data
      ?.creation_path;
    // Unknown, expired or used: refused. Anything else (a sealed or failing OpenBao) is not the
    // token's fault (C11: only a refused token is a security signal, ADR-M42 §2.5).
    if ([400, 403, 404].includes(lookup.status)) {
      throw new SecretsError('secrets.wrapping.invalid_token');
    }
    if (lookup.status !== 200) {
      throw new SecretsError('secrets.openbao.invalid_response', { operation: 'unwrap' });
    }
    if (creationPath !== WRAP_PATH) throw new SecretsError('secrets.wrapping.wrong_origin');
    // 2. Unwrap, authenticated by the wrapping token itself. It works once.
    const res = await this.raw('POST', 'sys/wrapping/unwrap', { token });
    if (res.status === 400 || res.status === 403) {
      throw new SecretsError('secrets.wrapping.invalid_token');
    }
    const data = (res.body as { data?: unknown } | undefined)?.data;
    if (res.status !== 200 || !data || typeof data !== 'object' || Array.isArray(data)) {
      throw new SecretsError('secrets.openbao.invalid_response', { operation: 'unwrap' });
    }
    const entries = Object.entries(data as Record<string, unknown>).map(
      ([name, value]) =>
        [name, new Redacted(typeof value === 'string' ? value : JSON.stringify(value))] as const,
    );
    return Object.freeze(Object.fromEntries(entries));
  }
}
