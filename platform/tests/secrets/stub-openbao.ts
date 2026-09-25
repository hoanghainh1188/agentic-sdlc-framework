// In-process stand-in for the OpenBao HTTP API, for unit tests of @sdlc/secrets (A04).
// It follows the behaviour seen on OpenBao 2.6 (see the live test): 503 "Vault is sealed" for
// every request while sealed or not initialised, 403 "permission denied" for an unknown token
// and for a policy refusal, `vault:v<N>:` Transit signatures.
//
// Every credential and secret value contains MARKER. The redaction tests check that MARKER never
// shows up in an error, a stack trace or a log field. OpenBao error texts here echo the input on
// purpose, to prove that the client never copies them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const MARKER = 'S3CR3T';
export const ROLE_ID = `role-${MARKER}-id`;
export const SECRET_ID = `secret-${MARKER}-id`;

type Reply = { status: number; body?: unknown };
type Handler = (req: http.IncomingMessage, body: Record<string, unknown>) => Reply | undefined;

interface KeyVersion {
  readonly privateKey: crypto.KeyObject;
  readonly publicRaw: Buffer;
}

export class StubOpenBao {
  initialized = true;
  sealed = false;
  /** TTL given at login; renewals give `renewTtl` (default: the same). */
  ttl = 3600;
  renewTtl: number | undefined;
  renewable = true;
  secretId = SECRET_ID;
  /** Paths (without `/v1/`) that a valid token may not use. */
  readonly denied = new Set<string>();
  readonly kv = new Map<string, Record<string, unknown>[]>();
  readonly tokens = new Map<string, number>(); // token → expiresAt
  readonly requests: string[] = [];
  /** Checked before the built-in routes; return undefined to fall through. */
  override: Handler | undefined;
  /** When set, login answers wait for this promise. */
  holdLogin: Promise<void> | undefined;
  readonly keys: KeyVersion[] = [newKey()];
  #server: http.Server | undefined;
  #tokenCount = 0;

  static async start(tls?: { key: Buffer; cert: Buffer }): Promise<StubOpenBao> {
    const stub = new StubOpenBao();
    const listener = (req: http.IncomingMessage, res: http.ServerResponse): void =>
      void stub.#handle(req, res);
    stub.#server = tls ? https.createServer(tls, listener) : http.createServer(listener);
    await new Promise<void>((resolve) => stub.#server!.listen(0, '127.0.0.1', resolve));
    return stub;
  }

  get port(): number {
    return (this.#server!.address() as AddressInfo).port;
  }

  get address(): string {
    return `${this.#server instanceof https.Server ? 'https' : 'http'}://127.0.0.1:${this.port}`;
  }

  count(request: string): number {
    return this.requests.filter((r) => r === request).length;
  }

  revokeAll(): void {
    this.tokens.clear();
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const url = new URL(req.url ?? '/', 'http://stub');
    this.requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname.endsWith('/approle/login')) await this.holdLogin;
    const reply = this.override?.(req, body) ?? this.#route(req, url, body);
    if (reply.status === 0) return; // never answer (timeout tests)
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  }

  #route(req: http.IncomingMessage, url: URL, body: Record<string, unknown>): Reply {
    const route = `${req.method} ${url.pathname.replace(/^\/v1\//, '')}`;
    if (route === 'GET sys/seal-status') {
      return {
        status: 200,
        body: { initialized: this.initialized, sealed: this.sealed, t: 2, n: 3 },
      };
    }
    if (!this.initialized || this.sealed)
      return { status: 503, body: { errors: ['Vault is sealed'] } };
    if (route === 'POST auth/approle/login') return this.#login(body);
    const token = String(req.headers['x-vault-token'] ?? '');
    if ((this.tokens.get(token) ?? 0) <= Date.now()) return denied(token);
    if (this.denied.has(route.split(' ')[1]!)) return denied(token);
    return this.#authenticated(route, url, token, body) ?? { status: 404, body: { errors: [] } };
  }

  #login(body: Record<string, unknown>): Reply {
    if (body['role_id'] !== ROLE_ID || body['secret_id'] !== this.secretId) {
      return {
        status: 400,
        body: { errors: [`invalid role or secret ID ${String(body['secret_id'])}`] },
      };
    }
    const token = `token-${MARKER}-${++this.#tokenCount}`;
    this.tokens.set(token, Date.now() + this.ttl * 1000);
    return { status: 200, body: auth(token, this.ttl, this.renewable) };
  }

  #authenticated(
    route: string,
    url: URL,
    token: string,
    body: Record<string, unknown>,
  ): Reply | undefined {
    const [method, p] = route.split(' ') as [string, string];
    if (route === 'GET auth/token/lookup-self') return { status: 200, body: { data: { ttl: 1 } } };
    if (route === 'POST auth/token/renew-self') {
      const ttl = this.renewTtl ?? this.ttl;
      this.tokens.set(token, Date.now() + ttl * 1000);
      return { status: 200, body: auth(token, ttl, this.renewable) };
    }
    if (route === 'POST auth/token/revoke-self') {
      this.tokens.delete(token);
      return { status: 204 };
    }
    if (method === 'GET' && p.startsWith('kv/data/')) return this.#kvRead(p.slice(8), url);
    if (p.startsWith('transit/')) return this.#transit(method, p, body);
    return undefined;
  }

  #kvRead(key: string, url: URL): Reply {
    const versions = this.kv.get(decodeURIComponent(key));
    const version = Number(url.searchParams.get('version') ?? versions?.length ?? 0);
    const data = versions?.[version - 1];
    if (!data) return { status: 404, body: { errors: [] } };
    return { status: 200, body: { data: { data, metadata: { version } } } };
  }

  #transit(method: string, p: string, body: Record<string, unknown>): Reply | undefined {
    if (method === 'GET' && p === 'transit/keys/run-contract') {
      const keys = Object.fromEntries(
        this.keys.map((k, i) => [
          String(i + 1),
          { name: 'ed25519', public_key: k.publicRaw.toString('base64') },
        ]),
      );
      return {
        status: 200,
        body: { data: { type: 'ed25519', keys, latest_version: this.keys.length } },
      };
    }
    const input = Buffer.from(String(body['input']), 'base64');
    if (p === 'transit/sign/run-contract') {
      const version = Number(body['key_version'] ?? this.keys.length);
      const key = this.keys[version - 1];
      if (!key)
        return { status: 400, body: { errors: ['requested version for signing is higher'] } };
      const sig = crypto.sign(null, input, key.privateKey).toString('base64');
      return {
        status: 200,
        body: { data: { signature: `vault:v${version}:${sig}`, key_version: version } },
      };
    }
    if (p === 'transit/verify/run-contract') {
      const match = /^vault:v(\d+):(.+)$/.exec(String(body['signature']));
      const key = match ? this.keys[Number(match[1]) - 1] : undefined;
      if (!match || !key) return { status: 400, body: { errors: ['invalid signature'] } };
      const valid = crypto.verify(null, input, key.privateKey, Buffer.from(match[2]!, 'base64'));
      return { status: 200, body: { data: { valid } } };
    }
    return undefined;
  }
}

function denied(token: string): Reply {
  return { status: 403, body: { errors: [`permission denied for ${token}`] } };
}

function auth(token: string, ttl: number, renewable: boolean): unknown {
  return {
    auth: {
      client_token: token,
      accessor: `acc-${MARKER}`,
      lease_duration: ttl,
      renewable,
      policies: ['worker'],
    },
  };
}

function newKey(): KeyVersion {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicRaw: der.subarray(der.length - 32) };
}

/** Writes the role ID and secret ID files (mode 600) in a new temp folder. */
export function credentialFiles(secretId = SECRET_ID): {
  dir: string;
  roleIdFile: string;
  secretIdFile: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-secrets-'));
  const roleIdFile = path.join(dir, 'role-id');
  const secretIdFile = path.join(dir, 'secret-id');
  fs.writeFileSync(roleIdFile, `${ROLE_ID}\n`, { mode: 0o600 });
  fs.writeFileSync(secretIdFile, `${secretId}\n`, { mode: 0o600 });
  return { dir, roleIdFile, secretIdFile };
}
