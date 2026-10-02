// A mocked API and a throw-away home folder for the user commands (B04 AC3). The token is built at
// run time, so no token-shaped literal is in the repository (Gitleaks rule `sdlc-api-token`).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach } from 'vitest';

import { runCli, type ApiIo, type CliContext } from '../../apps/cli/src/index.js';
import { writeSavedLogin } from '../../apps/cli/src/credentials/store.js';

export const TOKEN = `sdlc_pat_${'t'.repeat(40)}abc`;
export const API_URL = 'https://sdlc.example.test';

export interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

/** Routes by `METHOD /path` (no query). A function gets the request. */
export type Routes = Record<string, Reply | ((request: Recorded) => Reply)>;

export interface HarnessOptions {
  readonly routes?: Routes;
  readonly env?: Record<string, string>;
  /** Save a login before the command runs (default true). */
  readonly loggedIn?: boolean;
  readonly stdin?: string;
  readonly tty?: boolean;
  readonly hidden?: string;
}

export interface Harness {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly requests: Recorded[];
  readonly home: string;
  run(argv: readonly string[]): Promise<number>;
}

const homes: string[] = [];

/** Registers the clean-up of the throw-away homes in the calling test file. */
export function useHarness(): (options?: HarnessOptions) => Promise<Harness> {
  afterEach(async () => {
    await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return makeHarness;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'sdlc-cli-'));
  homes.push(home);
  const env = { HOME: home, ...options.env };
  if (options.loggedIn !== false) await writeSavedLogin(env, { apiUrl: API_URL, token: TOKEN });
  const out: string[] = [];
  const err: string[] = [];
  const requests: Recorded[] = [];
  const routes = options.routes ?? {};
  const fakeFetch = ((input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const request: Recorded = {
      method: init?.method ?? 'GET',
      url,
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    requests.push(request);
    const route = routes[`${request.method} ${url.pathname}`];
    const reply: Reply =
      route === undefined
        ? { status: 404, body: { error: { code: 'not_found', message: 'x' } } }
        : typeof route === 'function'
          ? route(request)
          : route;
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  const api: ApiIo = {
    fetch: fakeFetch,
    readHiddenLine: () => Promise.resolve(options.hidden ?? ''),
    readStdin: () => Promise.resolve(options.stdin ?? ''),
    stdinIsTTY: options.tty ?? false,
  };
  const ctx: CliContext = {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    connect: () => {
      throw new Error('no database in CLI user-command tests');
    },
    api,
  };
  return { ctx, out, err, requests, home, run: (argv) => runCli(argv, ctx) };
}

/** An API error envelope as the API sends it. */
export function apiError(status: number, code: string, extra: Record<string, unknown> = {}): Reply {
  return { status, body: { error: { code, message: `server text for ${code}`, ...extra } } };
}
