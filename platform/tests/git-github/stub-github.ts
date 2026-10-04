// In-process GitHub REST stub for the GitHub adapter tests (D-08 B05). No real GitHub: recorded
// shapes of the REST answers, a real HTTP server on 127.0.0.1, and a real RSA key per run, so the
// App JWT is verified exactly like GitHub does (RS256, `iss`, `iat`, `exp`).
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { RedactedSecret, SecretEntry, SecretReader } from '@sdlc/contracts';

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: unknown;
}

export interface StubAnswer {
  readonly status?: number;
  readonly body?: unknown;
  /** Raw bytes instead of JSON. */
  readonly raw?: Buffer;
  readonly headers?: Record<string, string>;
}

export type Handler = (req: StubRequest) => StubAnswer | Promise<StubAnswer>;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const APP_PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
export const APP_CLIENT_ID = 'Iv23liTestClient';
export const INSTALLATION_ID = 4242;

export const secret = (value: string): RedactedSecret => ({ reveal: () => value });

/** A `SecretReader` holding the GitHub App entry; counts reads. */
export class FakeSecrets implements SecretReader {
  reads = 0;
  paths: string[] = [];
  data: Record<string, string> = { client_id: APP_CLIENT_ID, private_key: APP_PRIVATE_KEY_PEM };
  version = 1;

  read(path: string): Promise<SecretEntry> {
    this.reads += 1;
    this.paths.push(path);
    return Promise.resolve({
      version: this.version,
      data: Object.fromEntries(Object.entries(this.data).map(([k, v]) => [k, secret(v)])),
    });
  }
}

export interface JwtClaims {
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
}

/** Verifies an App JWT with the public key; returns the header and claims, or null. */
export function verifyJwt(
  token: string,
  key: KeyObject = publicKey,
): { header: Record<string, unknown>; claims: JwtClaims } | null {
  const [h, c, s] = token.split('.');
  if (!h || !c || !s) return null;
  if (!verify('sha256', Buffer.from(`${h}.${c}`), key, Buffer.from(s, 'base64url'))) return null;
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(c, 'base64url').toString()) as JwtClaims,
  };
}

export class StubGitHub {
  readonly requests: StubRequest[] = [];
  readonly issuedTokens: { token: string; body: Record<string, unknown> }[] = [];
  /** Clock of the stub (the `Date` header and token expiry). */
  now = new Date('2026-09-26T08:00:00.000Z');
  tokenLifetimeMs = 60 * 60 * 1000;
  #routes = new Map<string, Handler>();
  /** C09: answers requests no exact route matches (path patterns), before the 404. */
  fallback: Handler | undefined;
  #server: http.Server;
  #tokenCounter = 0;
  address = '';

  constructor() {
    this.#server = http.createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.address = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** Sets the answer of `METHOD /path` (path without query). */
  on(method: string, path: string, handler: Handler | StubAnswer): void {
    this.#routes.set(`${method} ${path}`, typeof handler === 'function' ? handler : () => handler);
  }

  requestsTo(method: string, path: string): StubRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const url = new URL(req.url ?? '/', 'http://stub');
    const request: StubRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
    this.requests.push(request);
    const answer = await this.#route(request);
    const headers: Record<string, string> = {
      date: this.now.toUTCString(),
      'x-ratelimit-remaining': '4999',
      ...(answer.raw ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      ...answer.headers,
    };
    res.writeHead(answer.status ?? 200, headers);
    if (answer.raw) res.end(answer.raw);
    else res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
  }

  async #route(req: StubRequest): Promise<StubAnswer> {
    const auth = String(req.headers.authorization ?? '');
    if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(req.path)) {
      if (!this.#validJwt(auth)) return { status: 401, body: { message: 'Bad credentials' } };
      const custom = this.#routes.get(`GET ${req.path}`);
      return custom ? custom(req) : { body: { id: INSTALLATION_ID } };
    }
    if (
      req.method === 'POST' &&
      req.path === `/app/installations/${INSTALLATION_ID}/access_tokens`
    ) {
      if (!this.#validJwt(auth)) return { status: 401, body: { message: 'Bad credentials' } };
      const custom = this.#routes.get(`POST ${req.path}`);
      if (custom) return custom(req);
      return this.issueToken(req.body as Record<string, unknown>);
    }
    if (!this.#validToken(auth)) return { status: 401, body: { message: 'Bad credentials' } };
    const handler = this.#routes.get(`${req.method} ${req.path}`) ?? this.fallback;
    return handler ? handler(req) : { status: 404, body: { message: 'Not Found' } };
  }

  /** The default token answer: exactly the requested repository and permissions. */
  issueToken(body: Record<string, unknown>): StubAnswer {
    this.#tokenCounter += 1;
    const token = `ghs_stubtoken${String(this.#tokenCounter).padStart(4, '0')}`;
    this.issuedTokens.push({ token, body });
    const repos = (body.repositories as string[] | undefined) ?? [];
    return {
      status: 201,
      body: {
        token,
        expires_at: new Date(this.now.getTime() + this.tokenLifetimeMs)
          .toISOString()
          .replace('.000Z', 'Z'),
        permissions: { metadata: 'read', ...(body.permissions as object) },
        repository_selection: 'selected',
        repositories: repos.map((name) => ({ name, full_name: `acme/${name}` })),
      },
    };
  }

  #validJwt(auth: string): boolean {
    const match = /^Bearer (.+)$/.exec(auth);
    if (!match?.[1]) return false;
    const jwt = verifyJwt(match[1]);
    const now = Math.floor(this.now.getTime() / 1000);
    return (
      jwt !== null &&
      jwt.header.alg === 'RS256' &&
      jwt.claims.iss === APP_CLIENT_ID &&
      jwt.claims.iat <= now &&
      jwt.claims.exp > now &&
      jwt.claims.exp - jwt.claims.iat <= 600
    );
  }

  #validToken(auth: string): boolean {
    const match = /^Bearer (ghs_\w+)$/.exec(auth);
    return match !== null && this.issuedTokens.some((t) => t.token === match[1]);
  }
}

// Recorded shapes of GitHub REST answers (trimmed to the fields the adapter reads, plus some).

export const user = (id: number, login: string, type: 'User' | 'Bot' = 'User') => ({
  id,
  login,
  type,
  node_id: `U_${id}`,
});

export const REPO = { owner: 'acme', name: 'shop' } as const;
export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);

export function comment(
  id: number,
  issue: number,
  createdAt: string,
  body: string,
  opts: { updatedAt?: string; pull?: boolean; author?: ReturnType<typeof user> } = {},
) {
  const kind = opts.pull ? 'pull' : 'issues';
  return {
    id,
    node_id: `IC_${id}`,
    html_url: `https://github.com/acme/shop/${kind}/${issue}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/acme/shop/issues/${issue}`,
    user: opts.author ?? user(1001, 'harry'),
    created_at: createdAt,
    updated_at: opts.updatedAt ?? createdAt,
    body,
    author_association: 'MEMBER',
  };
}

export function pull(number: number, updatedAt: string, head = SHA_A, state = 'open') {
  return {
    number,
    state,
    draft: false,
    html_url: `https://github.com/acme/shop/pull/${number}`,
    user: user(2002, 'agent-bot[bot]', 'Bot'),
    head: { sha: head, ref: `agent/INT-2026-000${number}` },
    base: { sha: SHA_B, ref: 'main' },
    merged_at: null as string | null,
    closed_at: state === 'closed' ? updatedAt : null,
    merge_commit_sha: null as string | null,
    changed_files: 2,
    updated_at: updatedAt,
    created_at: '2026-09-25T00:00:00Z',
    title: 'Free text title',
    body: 'Free text body',
  };
}

export function review(
  id: number,
  reviewer: ReturnType<typeof user>,
  state: string,
  submittedAt: string | null,
  commit = SHA_A,
) {
  return {
    id,
    user: reviewer,
    state,
    commit_id: commit,
    submitted_at: submittedAt,
    html_url: `https://github.com/acme/shop/pull/7#pullrequestreview-${id}`,
    body: 'Free text',
  };
}

export function checkRun(
  id: number,
  name: string,
  conclusion: string | null,
  completedAt: string | null,
) {
  return {
    id,
    name,
    head_sha: SHA_A,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    completed_at: completedAt,
    html_url: `https://github.com/acme/shop/runs/${id}`,
  };
}

export function status(id: number, context: string, state: string, updatedAt: string) {
  return {
    id,
    context,
    state,
    updated_at: updatedAt,
    created_at: updatedAt,
    target_url: `https://ci.example.com/build/${id}`,
    url: `https://api.github.com/repos/acme/shop/statuses/${SHA_A}`,
  };
}
