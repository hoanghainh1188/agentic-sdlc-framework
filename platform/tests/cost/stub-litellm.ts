// In-process stand-in for the LiteLLM admin API (v1.104.0 shapes, checked live in ADR-M24 §2.2).
// Records every request, so tests can check what the adapter sends. Every answer and error text
// echoes a marker, so tests can check that nothing from LiteLLM leaks into errors.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const MASTER_KEY = 'sk-master-MARKER-0123456789';
export const ECHO_MARKER = 'LITELLM-ECHO-MARKER';

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface StubReply {
  readonly status?: number;
  readonly body?: unknown;
}

type Handler = (request: StubRequest) => StubReply | undefined;

export class StubLiteLLM {
  readonly requests: StubRequest[] = [];
  private handlers: Handler[] = [];
  /** Bearer keys accepted besides the master key (run keys, C07). */
  private readonly keys = new Set<string>();

  private constructor(
    private readonly server: http.Server,
    readonly url: string,
  ) {}

  static async start(): Promise<StubLiteLLM> {
    const holder: { stub?: StubLiteLLM } = {};
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://stub');
        const request: StubRequest = {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          authorization: req.headers.authorization,
          body: raw ? (JSON.parse(raw) as unknown) : undefined,
        };
        holder.stub!.requests.push(request);
        const reply = holder.stub!.reply(request);
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? {}));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    holder.stub = new StubLiteLLM(server, `http://127.0.0.1:${port}`);
    return holder.stub;
  }

  /** Adds a handler; the latest matching handler answers. */
  on(method: string, path: string, reply: (r: StubRequest) => StubReply): void {
    this.handlers.unshift((r) => (r.method === method && r.path === path ? reply(r) : undefined));
  }

  /** Accepts `key` as a bearer too (a run's virtual key, C07). */
  allowKey(key: string): void {
    this.keys.add(key);
  }

  reset(): void {
    this.requests.length = 0;
    this.handlers = [];
    this.keys.clear();
  }

  private reply(request: StubRequest): StubReply {
    const bearer = request.authorization?.replace(/^Bearer /, '');
    if (bearer !== MASTER_KEY && (bearer === undefined || !this.keys.has(bearer))) {
      return { status: 401, body: { error: { message: `bad key ${ECHO_MARKER}` } } };
    }
    for (const handler of this.handlers) {
      const reply = handler(request);
      if (reply) return reply;
    }
    return { status: 404, body: { error: { message: `no route ${ECHO_MARKER}`, code: '404' } } };
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
