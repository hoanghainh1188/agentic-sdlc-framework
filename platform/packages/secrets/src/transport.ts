// HTTP(S) requests to OpenBao on node:http / node:https (design/ADR-M21 §2.1).
//
// TLS: certificate verification is always on (`rejectUnauthorized: true`). No option turns it
// off (QUESTIONS #20). With a CA file, only that CA is trusted; otherwise Node's default roots.
import http from 'node:http';
import https from 'node:https';

import { SecretsError } from './errors.js';
import type { ResolvedOptions } from './options.js';

export interface HttpResponse {
  readonly status: number;
  /** Parsed JSON body, or undefined when the body is empty or not JSON. */
  readonly body: unknown;
}

export interface RequestInput {
  readonly token?: string;
  readonly body?: unknown;
}

const MAX_BODY_BYTES = 1024 * 1024;
// Error codes from OpenSSL / Node for a certificate or TLS handshake failure.
const TLS_ERROR = /CERT|SELF_SIGNED|ISSUER|SIGNATURE|TLS|SSL|ALTNAME|HOSTNAME/i;

export class Transport {
  readonly #options: ResolvedOptions;
  readonly #agent: http.Agent;

  constructor(options: ResolvedOptions) {
    this.#options = options;
    this.#agent = options.plaintext
      ? new http.Agent({ keepAlive: true })
      : new https.Agent({
          keepAlive: true,
          rejectUnauthorized: true,
          ...(options.ca ? { ca: options.ca } : {}),
        });
  }

  get address(): string {
    return this.#options.origin.origin;
  }

  request(method: 'GET' | 'POST', path: string, input: RequestInput = {}): Promise<HttpResponse> {
    const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
    const headers: Record<string, string> = { 'X-Vault-Request': 'true' };
    if (input.token) headers['X-Vault-Token'] = input.token;
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const url = new URL(`/v1/${path}`, this.#options.origin);
    const send = this.#options.plaintext ? http.request : https.request;
    return new Promise<HttpResponse>((resolve, reject) => {
      const req = send(url, { method, headers, agent: this.#agent }, (res) => {
        readBody(res).then(
          (body) => resolve({ status: res.statusCode ?? 0, body }),
          () => reject(new SecretsError('secrets.openbao.invalid_response', { operation: path })),
        );
      });
      req.setTimeout(this.#options.timeoutMs, () => {
        req.destroy(
          new SecretsError('secrets.openbao.timeout', {
            address: this.address,
            seconds: this.#options.timeoutMs / 1000,
          }),
        );
      });
      req.on('error', (error) => reject(this.#translate(error)));
      req.end(payload);
    });
  }

  close(): void {
    this.#agent.destroy();
  }

  #translate(error: Error): SecretsError {
    if (error instanceof SecretsError) return error;
    const reason = (error as NodeJS.ErrnoException).code ?? 'unknown';
    if (!this.#options.plaintext && TLS_ERROR.test(reason)) {
      return new SecretsError('secrets.openbao.tls_failed', {
        address: this.address,
        reason,
        name: 'SDLC_OPENBAO_CA_CERT_FILE',
      });
    }
    return new SecretsError('secrets.openbao.unreachable', { address: this.address, reason });
  }
}

async function readBody(res: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('response too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
