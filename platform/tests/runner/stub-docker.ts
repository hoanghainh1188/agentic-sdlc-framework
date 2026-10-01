// In-process Docker Engine API stub on a Unix socket, for the runner unit tests (ADR-M25). It keeps
// containers, networks and volumes in memory, records every call, and can fail a chosen call.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: unknown;
}

interface StubContainer {
  id: string;
  name: string;
  spec: Record<string, unknown>;
  running: boolean;
  archives: string[];
  /** Answer of `GET /containers/{id}/archive` (a tar), when a test sets it. */
  exported?: Buffer;
}

export class StubDocker {
  readonly calls: Call[] = [];
  readonly containers = new Map<string, StubContainer>();
  readonly networks = new Map<string, { labels: Record<string, string>; attached: Set<string> }>();
  readonly volumes = new Map<string, Record<string, string>>();
  readonly images = new Set<string>();
  /** Health status reported for started containers; undefined = the image has no health check. */
  health: 'healthy' | 'unhealthy' | 'starting' | undefined = 'healthy';
  /** `METHOD /path` pattern → HTTP status to answer instead of the normal result. */
  readonly failures = new Map<RegExp, number>();
  #seq = 0;

  private constructor(
    readonly socketPath: string,
    private readonly server: http.Server,
    private readonly dir: string,
  ) {}

  static async start(): Promise<StubDocker> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-stub-docker-'));
    const socketPath = path.join(dir, 'docker.sock');
    const holder: { stub?: StubDocker } = {};
    const server = http.createServer((req, res) => holder.stub!.handle(req, res));
    const stub = new StubDocker(socketPath, server, dir);
    holder.stub = stub;
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return stub;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Paths called, as `METHOD /path` without the API version. */
  get trace(): string[] {
    return this.calls.map((c) => `${c.method} ${c.path}`);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://docker');
      const apiPath = url.pathname.replace(/^\/v1\.\d+/, '');
      const raw = Buffer.concat(chunks);
      const isJson = (req.headers['content-type'] ?? '').includes('json');
      const body: unknown = raw.length && isJson ? JSON.parse(raw.toString('utf8')) : raw;
      const call = {
        method: req.method ?? 'GET',
        path: apiPath,
        query: Object.fromEntries(url.searchParams),
        body,
      };
      this.calls.push(call);
      const failure = [...this.failures].find(([pattern]) =>
        pattern.test(`${call.method} ${call.path}`),
      );
      if (failure) return send(res, failure[1], { message: 'echo of secret-value from request' });
      const [status, payload] = this.route(call);
      send(res, status, payload);
    });
  }

  private list(p: string, query: Record<string, string>): unknown {
    if (p === '/containers/json') {
      return [...this.containers.values()]
        .filter((x) => matches(x.spec.Labels as Record<string, string>, query))
        .map((x) => ({
          Id: x.id,
          Names: [`/${x.name}`],
          Labels: x.spec.Labels,
          State: x.running ? 'running' : 'created',
        }));
    }
    if (p === '/networks') {
      return [...this.networks]
        .filter(([, n]) => matches(n.labels, query))
        .map(([name, n]) => ({ Id: name, Name: name, Internal: true, Labels: n.labels }));
    }
    return {
      Volumes: [...this.volumes]
        .filter(([, labels]) => matches(labels, query))
        .map(([name, labels]) => ({ Name: name, Labels: labels })),
    };
  }

  private route(c: Call): [number, unknown] {
    const m = c.method;
    const p = c.path;
    let match: RegExpExecArray | null;
    if (m === 'GET' && p === '/_ping') return [200, 'OK'];
    if (m === 'GET' && (match = /^\/images\/(.+)\/json$/.exec(p))) {
      return this.images.has(match[1]!)
        ? [200, { Id: 'sha256:img', RepoDigests: [match[1]] }]
        : [404, {}];
    }
    if (m === 'POST' && p === '/images/create') {
      this.images.add(c.query.fromImage!);
      return [200, { status: 'Downloaded' }];
    }
    if (m === 'GET' && (p === '/containers/json' || p === '/networks' || p === '/volumes')) {
      return [200, this.list(p, c.query)];
    }
    if (m === 'POST' && p === '/volumes/create') {
      // Like Docker: creating an existing volume is not an error, and keeps the first labels.
      const b = c.body as { Name: string; Labels: Record<string, string> };
      if (!this.volumes.has(b.Name)) this.volumes.set(b.Name, b.Labels);
      return [201, { Name: b.Name }];
    }
    if (m === 'DELETE' && (match = /^\/volumes\/(.+)$/.exec(p))) {
      return this.volumes.delete(match[1]!) ? [204, ''] : [404, {}];
    }
    if (m === 'POST' && p === '/networks/create') {
      const b = c.body as { Name: string; Labels: Record<string, string> };
      if (this.networks.has(b.Name)) return [409, {}];
      this.networks.set(b.Name, { labels: b.Labels, attached: new Set() });
      return [201, { Id: `net-${b.Name}` }];
    }
    if ((match = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(p))) {
      const net = this.networks.get(match[1]!);
      const container = (c.body as { Container: string }).Container;
      if (!net) return [404, {}];
      if (match[2] === 'connect') net.attached.add(container);
      // Real Docker answers 500 for a container that is not attached.
      else if (!net.attached.delete(container)) return [500, {}];
      return [200, ''];
    }
    if (m === 'GET' && (match = /^\/networks\/([^/]+)$/.exec(p))) {
      const net = this.networks.get(match[1]!);
      if (!net) return [404, {}];
      const containers = Object.fromEntries(
        [...net.attached].map((name) => [`id-${name}`, { Name: name }]),
      );
      return [
        200,
        {
          Id: match[1],
          Name: match[1],
          Internal: true,
          Labels: net.labels,
          Containers: containers,
        },
      ];
    }
    if (m === 'DELETE' && (match = /^\/networks\/([^/]+)$/.exec(p))) {
      const net = this.networks.get(match[1]!);
      if (!net) return [404, {}];
      if (net.attached.size > 0) return [409, {}]; // Docker refuses a network with endpoints
      this.networks.delete(match[1]!);
      return [204, ''];
    }
    if (m === 'POST' && p === '/containers/create') {
      const name = c.query.name!;
      if ([...this.containers.values()].some((x) => x.name === name)) return [409, {}];
      const id = `c${String(++this.#seq)}`;
      this.containers.set(id, {
        id,
        name,
        spec: c.body as Record<string, unknown>,
        running: false,
        archives: [],
      });
      const network = (c.body as { HostConfig: { NetworkMode: string } }).HostConfig.NetworkMode;
      this.networks.get(network)?.attached.add(name);
      return [201, { Id: id }];
    }
    const container = (ref: string) =>
      this.containers.get(ref) ?? [...this.containers.values()].find((x) => x.name === ref);
    if (m === 'PUT' && (match = /^\/containers\/([^/]+)\/archive$/.exec(p))) {
      const x = container(match[1]!);
      if (!x) return [404, {}];
      x.archives.push(c.query.path!);
      return [200, ''];
    }
    if (m === 'GET' && (match = /^\/containers\/([^/]+)\/archive$/.exec(p))) {
      const x = container(match[1]!);
      if (!x?.exported) return [404, {}];
      return [200, x.exported];
    }
    if (m === 'GET' && (match = /^\/containers\/([^/]+)\/json$/.exec(p))) {
      const x = container(match[1]!);
      if (!x) return [404, {}];
      return [
        200,
        {
          Id: x.id,
          Name: `/${x.name}`,
          Config: { Labels: (x.spec.Labels as Record<string, string> | undefined) ?? null },
          State: {
            Status: x.running ? 'running' : 'created',
            Running: x.running,
            ExitCode: 0,
            ...(this.health && x.running ? { Health: { Status: this.health } } : {}),
          },
        },
      ];
    }
    if (m === 'POST' && (match = /^\/containers\/([^/]+)\/start$/.exec(p))) {
      const x = container(match[1]!);
      if (!x) return [404, {}];
      x.running = true;
      return [204, ''];
    }
    if (m === 'DELETE' && (match = /^\/containers\/([^/]+)$/.exec(p))) {
      const x = container(match[1]!);
      if (!x) return [404, {}];
      this.containers.delete(x.id);
      for (const net of this.networks.values()) net.attached.delete(x.name);
      return [204, ''];
    }
    return [500, { message: `stub: no route for ${m} ${p}` }];
  }
}

/** `filters={"label":["k=v",…]}`: every pair must match. */
function matches(
  labels: Record<string, string> | undefined,
  query: Record<string, string>,
): boolean {
  const wanted = (JSON.parse(query.filters ?? '{}') as { label?: string[] }).label ?? [];
  return wanted.every((pair) => {
    const at = pair.indexOf('=');
    return labels?.[pair.slice(0, at)] === pair.slice(at + 1);
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  if (Buffer.isBuffer(payload)) {
    res.writeHead(status, { 'content-type': 'application/x-tar' });
    res.end(payload);
    return;
  }
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}
