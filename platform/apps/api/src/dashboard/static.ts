// The read-only dashboard's static files (task U01, design/ADR-M54 §2.2). The api serves the
// built files under `/dashboard/` on its own origin, so the dashboard calls the API with no CORS
// and no new port. Only the files found once at start-up are served: the request path is a key
// in that list, never a path on disk. Every answer carries a strict Content-Security-Policy.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** The parts of Fastify's reply used here (the api does not depend on `fastify` directly). */
interface Reply {
  header(name: string, value: string): Reply;
  code(status: number): Reply;
  type(contentType: string): Reply;
  redirect(url: string, status: number): Reply;
  send(body?: Buffer | string): Reply;
}

interface Request {
  readonly params: { readonly '*': string };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

type Handler = (request: Request, reply: Reply) => Reply;

/** The part of the Fastify instance used here. */
export interface RouteHost {
  get(path: string, handler: Handler): unknown;
}

/** The route prefix. */
export const DASHBOARD_PREFIX = '/dashboard/';

/**
 * No inline script or style, no third-party origin, no frames, no forms, no plugins: every asset
 * comes from the platform, and the page talks only to its own origin.
 */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

/** Limits on what a build may hold; a larger folder is refused at start-up. */
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export interface DashboardFile {
  readonly body: Buffer;
  readonly contentType: string;
  readonly etag: string;
  /** Content-hashed names under `assets/` never change: cached for a year. */
  readonly immutable: boolean;
}

/** The served files by their path under `/dashboard/` (`index.html`, `assets/…`). */
export type DashboardFiles = ReadonlyMap<string, DashboardFile>;

export class DashboardFilesError extends Error {
  override readonly name = 'DashboardFilesError';
  constructor(readonly code: 'missing_index' | 'too_large' | 'unexpected_file') {
    super(`dashboard files: ${code}`);
  }
}

/** Reads the built dashboard once. Symbolic links and unknown file types are refused. */
export async function loadDashboardFiles(dir: string): Promise<DashboardFiles> {
  const files = new Map<string, DashboardFile>();
  let total = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const key = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(key);
        continue;
      }
      const contentType = CONTENT_TYPES[path.extname(entry.name)];
      if (!entry.isFile() || contentType === undefined || !/^[A-Za-z0-9._/-]+$/.test(key)) {
        throw new DashboardFilesError('unexpected_file');
      }
      const full = path.join(dir, key);
      total += (await stat(full)).size;
      if (files.size >= MAX_FILES || total > MAX_TOTAL_BYTES) {
        throw new DashboardFilesError('too_large');
      }
      const body = await readFile(full);
      files.set(key, {
        body,
        contentType,
        etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`,
        immutable: key.startsWith('assets/'),
      });
    }
  };
  await walk('');
  if (!files.has('index.html')) throw new DashboardFilesError('missing_index');
  return files;
}

/** `If-None-Match`: one tag, a list, or weak tags (`W/"…"`) a proxy may send. */
function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  return value
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === etag || tag === '*');
}

function secure(reply: Reply): Reply {
  return reply
    .header('content-security-policy', DASHBOARD_CSP)
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('cross-origin-opener-policy', 'same-origin')
    .header('cross-origin-resource-policy', 'same-origin')
    .header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    .header('x-frame-options', 'DENY');
}

/**
 * Registers `GET /dashboard`, `GET /dashboard/` and `GET /dashboard/*`. These routes sit outside
 * the API's guard on purpose: they serve the same public files to everyone, and the dashboard
 * signs in to the API with a personal token held in memory only (ADR-M54 §2.3).
 */
export function registerDashboard(fastify: RouteHost, files: DashboardFiles): void {
  fastify.get('/dashboard', (_request, reply) =>
    secure(reply).header('cache-control', 'no-store').redirect(DASHBOARD_PREFIX, 308),
  );
  fastify.get(`${DASHBOARD_PREFIX}*`, (request, reply) => {
    const key = request.params['*'] === '' ? 'index.html' : request.params['*'];
    const file = files.get(key);
    secure(reply);
    if (!file) {
      return reply
        .code(404)
        .header('cache-control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send('not found');
    }
    reply
      .header('cache-control', file.immutable ? 'public, max-age=31536000, immutable' : 'no-store')
      .header('etag', file.etag)
      .type(file.contentType);
    if (matchesEtag(request.headers['if-none-match'], file.etag)) return reply.code(304).send();
    return reply.send(file.body);
  });
}
