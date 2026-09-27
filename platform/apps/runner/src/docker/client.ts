// Small Docker Engine API client over the Unix socket (ADR-M25 §2.5). No dependencies, like the
// OpenBao client (ADR-M21) and the GitHub adapter (ADR-M23): about fifteen endpoints, and full
// control over what goes into errors and logs.
//
// The socket gives root-equivalent power over the host (D-03 §13). The client therefore:
// - calls only the endpoints in ALLOWED_ENDPOINTS (no exec, build, commit, swarm, plugins, system);
// - sends every container and network definition through the guard (guard.ts) first;
// - never puts Docker's own error text into an error: it can echo request data.
import http from 'node:http';

import { RunnerError } from '../errors.js';
import { assertSafeContainerSpec, assertSafeNetworkSpec, type ContainerSpec } from './guard.js';

/** Docker Engine 25 or later (API 1.44). The server answers older versions for newer clients. */
export const DOCKER_API_VERSION = 'v1.44';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type Method = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'HEAD';

const NAME = '[a-zA-Z0-9][a-zA-Z0-9_.-]*';
/** A run sandbox's container name (`names.ts`): the only container whose files are read. */
const SANDBOX = 'sdlc-sandbox-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Every endpoint the runner may call. Anything else is refused before it reaches the socket. */
export const ALLOWED_ENDPOINTS: readonly (readonly [Method, RegExp])[] = [
  ['GET', /^\/_ping$/],
  [
    'GET',
    new RegExp(
      `^/images/${NAME}(?::[0-9]{1,5})?(?:/${NAME})*(?::[\\w.-]+)?(?:@sha256:[0-9a-f]{64})?/json$`,
    ),
  ],
  ['POST', /^\/images\/create$/],
  ['GET', /^\/containers\/json$/],
  ['POST', /^\/containers\/create$/],
  ['GET', new RegExp(`^/containers/${NAME}/json$`)],
  ['POST', new RegExp(`^/containers/${NAME}/start$`)],
  ['POST', new RegExp(`^/containers/${NAME}/wait$`)],
  ['GET', new RegExp(`^/containers/${NAME}/logs$`)],
  ['PUT', new RegExp(`^/containers/${NAME}/archive$`)],
  // C06 session 2b (ADR-M33 §2.9): read the workspace out of a run sandbox only;
  // `exportWorkspace` also checks the container's name and this runner's labels first.
  ['GET', new RegExp(`^/containers/${SANDBOX}/archive$`)],
  ['DELETE', new RegExp(`^/containers/${NAME}$`)],
  ['GET', /^\/networks$/],
  ['POST', /^\/networks\/create$/],
  ['GET', new RegExp(`^/networks/${NAME}$`)],
  ['POST', new RegExp(`^/networks/${NAME}/(?:connect|disconnect)$`)],
  ['DELETE', new RegExp(`^/networks/${NAME}$`)],
  ['GET', /^\/volumes$/],
  ['POST', /^\/volumes\/create$/],
  ['DELETE', new RegExp(`^/volumes/${NAME}$`)],
];

export function isAllowedEndpoint(method: string, path: string): boolean {
  return ALLOWED_ENDPOINTS.some(([m, pattern]) => m === method && pattern.test(path));
}

export interface DockerResponse {
  readonly status: number;
  readonly body: Buffer;
}

export interface ContainerSummary {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly State: string;
}

export interface ContainerInfo {
  readonly Id: string;
  readonly Name: string;
  readonly Image: string;
  readonly State: {
    readonly Status: string;
    readonly Running: boolean;
    readonly ExitCode: number;
    readonly Health?: { readonly Status: string };
  };
  readonly Config: {
    readonly Env: readonly string[] | null;
    readonly Labels: Readonly<Record<string, string>> | null;
  };
  readonly HostConfig: Readonly<Record<string, unknown>>;
  readonly Mounts: readonly {
    readonly Type: string;
    readonly Name?: string;
    readonly Destination: string;
  }[];
  readonly NetworkSettings: { readonly Networks: Readonly<Record<string, unknown>> };
}

export interface NetworkSummary {
  readonly Id: string;
  readonly Name: string;
  readonly Internal: boolean;
  readonly Labels: Readonly<Record<string, string>> | null;
  readonly Containers?: Readonly<Record<string, { readonly Name: string }>>;
}

export interface NetworkSpec {
  readonly Name: string;
  readonly Driver: 'bridge';
  readonly Internal: true;
  readonly Attachable: false;
  readonly EnableIPv6: false;
  readonly Labels: Readonly<Record<string, string>>;
  readonly Options: { readonly 'com.docker.network.bridge.inhibit_ipv4': 'true' };
}

export interface VolumeSummary {
  readonly Name: string;
  readonly Labels: Readonly<Record<string, string>> | null;
}

export interface DockerClientOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
}

/** A filter for the list endpoints: `label=key=value` pairs, all required. */
export type LabelFilter = Readonly<Record<string, string>>;

function labelFilter(labels: LabelFilter): Record<string, string> {
  return {
    filters: JSON.stringify({
      label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
    }),
  };
}

export class DockerClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;

  constructor(options: DockerClientOptions) {
    this.#socketPath = options.socketPath;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ping(): Promise<void> {
    await this.#expect('GET', '/_ping', [200]);
  }

  /** Image details, or undefined when the image is not on this host. */
  async imageInspect(ref: string): Promise<{ Id: string; RepoDigests: string[] } | undefined> {
    const res = await this.request('GET', `/images/${ref}/json`);
    if (res.status === 404) return undefined;
    this.#check(res, [200], 'GET');
    return JSON.parse(res.body.toString('utf8')) as { Id: string; RepoDigests: string[] };
  }

  /** Pulls an image by digest (`name@sha256:…`); tags alone are refused. */
  async imagePull(ref: string): Promise<void> {
    const at = ref.lastIndexOf('@sha256:');
    if (at < 0) throw new RunnerError('runner.docker.image_not_pinned');
    // The answer is a progress stream; an error inside it shows up as an `error` field.
    const res = await this.#expect('POST', '/images/create', [200], undefined, { fromImage: ref });
    if (/"error(?:Detail)?"\s*:/.test(res.body.toString('utf8'))) {
      throw new RunnerError('runner.docker.pull_failed');
    }
  }

  async containerList(labels: LabelFilter): Promise<ContainerSummary[]> {
    const res = await this.#expect('GET', '/containers/json', [200], undefined, {
      all: 'true',
      ...labelFilter(labels),
    });
    return JSON.parse(res.body.toString('utf8')) as ContainerSummary[];
  }

  /** Creates a container from a guarded spec (guard.ts). Returns its ID. */
  async containerCreate(name: string, spec: ContainerSpec): Promise<string> {
    assertSafeContainerSpec(name, spec);
    const res = await this.#expect('POST', '/containers/create', [201], spec, { name });
    return (JSON.parse(res.body.toString('utf8')) as { Id: string }).Id;
  }

  /**
   * Extracts a tar archive into a created container before it starts (S2: the workspace). Docker
   * writes into the container's volumes, so the archive lands in the run's workspace volume.
   */
  async putArchive(id: string, path: string, tar: Buffer): Promise<void> {
    // copyUIDGID: keep the owners written in the archive (the sandbox user, workspace/tar.ts).
    const res = await this.request('PUT', `/containers/${id}/archive`, tar, {
      path,
      copyUIDGID: 'true',
    });
    this.#check(res, [200], 'PUT');
  }

  /**
   * Reads a path of a container as a tar archive (C06 session 2b). The caller checks that the
   * container is the run's own sandbox (`workspace/export.ts`) and treats the archive as untrusted.
   */
  async getArchive(name: string, path: string, maxBytes: number): Promise<Buffer> {
    const res = await this.request(
      'GET',
      `/containers/${name}/archive`,
      undefined,
      { path },
      {
        maxBytes,
      },
    );
    this.#check(res, [200], 'GET');
    return res.body;
  }

  async containerStart(id: string): Promise<void> {
    await this.#expect('POST', `/containers/${id}/start`, [204, 304]);
  }

  async containerInspect(id: string): Promise<ContainerInfo | undefined> {
    const res = await this.request('GET', `/containers/${id}/json`);
    if (res.status === 404) return undefined;
    this.#check(res, [200], 'GET');
    return JSON.parse(res.body.toString('utf8')) as ContainerInfo;
  }

  /** Waits until the container exits; returns its exit code. */
  async containerWait(id: string, timeoutMs: number): Promise<number> {
    const res = await this.request('POST', `/containers/${id}/wait`, undefined, {}, { timeoutMs });
    this.#check(res, [200], 'POST');
    return (JSON.parse(res.body.toString('utf8')) as { StatusCode: number }).StatusCode;
  }

  /** Standard output of a stopped container (multiplexed stream, headers removed). */
  async containerLogs(id: string): Promise<string> {
    const res = await this.#expect('GET', `/containers/${id}/logs`, [200], undefined, {
      stdout: 'true',
      stderr: 'false',
    });
    return demultiplex(res.body);
  }

  /** Removes a container and its anonymous volumes. Returns false when it did not exist. */
  async containerRemove(id: string): Promise<boolean> {
    const res = await this.request('DELETE', `/containers/${id}`, undefined, {
      force: 'true',
      v: 'true',
    });
    if (res.status === 404) return false;
    this.#check(res, [204], 'DELETE');
    return true;
  }

  async networkList(labels: LabelFilter): Promise<NetworkSummary[]> {
    const res = await this.#expect('GET', '/networks', [200], undefined, labelFilter(labels));
    return JSON.parse(res.body.toString('utf8')) as NetworkSummary[];
  }

  async networkCreate(spec: NetworkSpec): Promise<string> {
    assertSafeNetworkSpec(spec);
    const res = await this.#expect('POST', '/networks/create', [201], spec);
    return (JSON.parse(res.body.toString('utf8')) as { Id: string }).Id;
  }

  async networkInspect(name: string): Promise<NetworkSummary | undefined> {
    const res = await this.request('GET', `/networks/${name}`);
    if (res.status === 404) return undefined;
    this.#check(res, [200], 'GET');
    return JSON.parse(res.body.toString('utf8')) as NetworkSummary;
  }

  /** Attaches a container to a network under DNS aliases. */
  async networkConnect(network: string, container: string, aliases: string[]): Promise<void> {
    await this.#expect('POST', `/networks/${network}/connect`, [200], {
      Container: container,
      EndpointConfig: { Aliases: aliases },
    });
  }

  /** Detaches a container. Returns false when the network or the attachment did not exist. */
  async networkDisconnect(network: string, container: string): Promise<boolean> {
    const res = await this.request('POST', `/networks/${network}/disconnect`, {
      Container: container,
      Force: true,
    });
    if (res.status === 404) return false;
    this.#check(res, [200], 'POST');
    return true;
  }

  async networkRemove(name: string): Promise<boolean> {
    const res = await this.request('DELETE', `/networks/${name}`);
    if (res.status === 404) return false;
    this.#check(res, [204], 'DELETE');
    return true;
  }

  async volumeList(labels: LabelFilter): Promise<VolumeSummary[]> {
    const res = await this.#expect('GET', '/volumes', [200], undefined, labelFilter(labels));
    return (
      (JSON.parse(res.body.toString('utf8')) as { Volumes: VolumeSummary[] | null }).Volumes ?? []
    );
  }

  async volumeCreate(name: string, labels: Readonly<Record<string, string>>): Promise<void> {
    await this.#expect('POST', '/volumes/create', [201], {
      Name: name,
      Driver: 'local',
      Labels: labels,
    });
  }

  async volumeRemove(name: string): Promise<boolean> {
    const res = await this.request('DELETE', `/volumes/${name}`, undefined, { force: 'true' });
    if (res.status === 404) return false;
    this.#check(res, [204], 'DELETE');
    return true;
  }

  /**
   * One HTTP call on the socket. Refuses endpoints outside ALLOWED_ENDPOINTS before connecting.
   * Public for tests; the typed methods above are the API.
   */
  request(
    method: Method,
    path: string,
    body?: unknown,
    query: Readonly<Record<string, string>> = {},
    options: { readonly timeoutMs?: number; readonly maxBytes?: number } = {},
  ): Promise<DockerResponse> {
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
    if (!isAllowedEndpoint(method, path)) {
      return Promise.reject(new RunnerError('runner.docker.endpoint_refused', { method }));
    }
    const search = new URLSearchParams(query).toString();
    const raw = Buffer.isBuffer(body);
    const payload =
      body === undefined ? undefined : raw ? body : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.#socketPath,
          method,
          path: `/${DOCKER_API_VERSION}${path}${search ? `?${search}` : ''}`,
          headers: {
            host: 'docker',
            ...(payload
              ? {
                  'content-type': raw ? 'application/x-tar' : 'application/json',
                  'content-length': payload.length,
                }
              : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy();
              reject(new RunnerError('runner.docker.response_too_large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          res.on('error', () => reject(unreachable('response')));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new RunnerError('runner.docker.timeout', { method }));
      });
      req.on('error', (error: NodeJS.ErrnoException) => reject(unreachable(error.code ?? 'error')));
      req.end(payload);
    });
  }

  async #expect(
    method: Method,
    path: string,
    ok: readonly number[],
    body?: unknown,
    query?: Readonly<Record<string, string>>,
  ): Promise<DockerResponse> {
    const res = await this.request(method, path, body, query);
    this.#check(res, ok, method);
    return res;
  }

  #check(res: DockerResponse, ok: readonly number[], method: string): void {
    if (ok.includes(res.status)) return;
    if (res.status === 404) throw new RunnerError('runner.docker.not_found', { method });
    if (res.status === 409) throw new RunnerError('runner.docker.conflict', { method });
    throw new RunnerError('runner.docker.api_error', { method, status: res.status });
  }
}

function unreachable(code: string): RunnerError {
  return new RunnerError('runner.docker.unreachable', { code });
}

/** Removes the 8-byte frame headers of Docker's multiplexed log stream (stdout frames only). */
export function demultiplex(stream: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= stream.length) {
    const type = stream[offset];
    const size = stream.readUInt32BE(offset + 4);
    if (type === 1) parts.push(stream.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}
