// U01 (design/ADR-M54 §2.2, AC1, AC3): the api serves the dashboard's built files under
// `/dashboard/` with a strict Content-Security-Policy; only files found at start-up, never a path
// from the request; the API's own routes keep their guard.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../apps/api/src/app.js';
import {
  DASHBOARD_CSP,
  DashboardFilesError,
  loadDashboardFiles,
} from '../../apps/api/src/dashboard/static.js';

const INDEX =
  '<!doctype html><title>SDLC</title><script type="module" src="./assets/app-1.js"></script>';

type App = Awaited<ReturnType<typeof createApp>>;

interface Reply {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
}

async function build(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sdlc-dashboard-'));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), body);
  }
  return dir;
}

describe('the dashboard files', () => {
  let dir: string;
  let app: App;

  beforeAll(async () => {
    dir = await build({
      'index.html': INDEX,
      'assets/app-1.js': 'export {};',
      'assets/app-1.css': 'body{}',
    });
    app = await createApp({
      // The dashboard routes never touch the database; the API's routes refuse without a token.
      db: {} as ApiDeps['db'],
      settings: { rateLimitPerMinute: 100, authFailuresPerMinute: 100 },
      dashboard: await loadDashboardFiles(dir),
    });
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const get = async (url: string, headers: Record<string, string> = {}): Promise<Reply> =>
    await app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers });

  it('serves index.html at /dashboard/ with the CSP and no caching', async () => {
    const reply = await get('/dashboard/');
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBe(INDEX);
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(reply.headers['content-security-policy']).toBe(DASHBOARD_CSP);
    expect(DASHBOARD_CSP).toContain("script-src 'self'");
    expect(DASHBOARD_CSP).not.toMatch(/unsafe|https?:|\*/);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    expect(reply.headers['x-frame-options']).toBe('DENY');
  });

  it('redirects /dashboard to /dashboard/', async () => {
    const reply = await get('/dashboard');
    expect(reply.statusCode).toBe(308);
    expect(reply.headers.location).toBe('/dashboard/');
  });

  it('caches hashed assets for a year and answers 304 to a matching ETag', async () => {
    const reply = await get('/dashboard/assets/app-1.js');
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(reply.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const again = await get('/dashboard/assets/app-1.js', {
      'if-none-match': String(reply.headers.etag),
    });
    expect(again.statusCode).toBe(304);
    const weak = await get('/dashboard/assets/app-1.js', {
      'if-none-match': `"other", W/${String(reply.headers.etag)}`,
    });
    expect(weak.statusCode).toBe(304);
  });

  it('serves only the listed files: no traversal, no unknown path', async () => {
    for (const url of [
      '/dashboard/../package.json',
      '/dashboard/%2e%2e/%2e%2e/etc/passwd',
      '/dashboard/assets/../../index.html',
      '/dashboard/missing.js',
      '/dashboard/assets/',
    ]) {
      const reply = await get(url);
      expect(reply.statusCode, url).not.toBe(200);
      expect(reply.body, url).not.toContain('"name"');
    }
    expect((await get('/dashboard/missing.js')).headers['content-security-policy']).toBe(
      DASHBOARD_CSP,
    );
  });

  it('the API keeps its guard: no token → 401', async () => {
    expect((await get('/v1/me')).statusCode).toBe(401);
  });

  it('refuses a build with a link, an unknown file type or no index.html', async () => {
    const noIndex = await build({ 'assets/a.js': '' });
    await expect(loadDashboardFiles(noIndex)).rejects.toThrow(DashboardFilesError);
    const odd = await build({ 'index.html': INDEX, 'notes.txt': 'x' });
    await expect(loadDashboardFiles(odd)).rejects.toThrow(DashboardFilesError);
    const linked = await build({ 'index.html': INDEX });
    await symlink('/etc/hosts', path.join(linked, 'hosts.js'));
    await expect(loadDashboardFiles(linked)).rejects.toThrow(DashboardFilesError);
    for (const d of [noIndex, odd, linked]) await rm(d, { recursive: true, force: true });
  });
});
