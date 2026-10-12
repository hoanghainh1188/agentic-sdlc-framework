// U01 AC1, AC2, AC3, AC5 (design/ADR-M54 §2.1, §2.3): static checks on the dashboard's source and
// build. Read only (GET, one API client), the token never stored, no HTML injection, no inline
// script or third-party asset, labels from the catalog, the bundle within its budget.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const appDir = path.join(root, 'platform/apps/dashboard');
const srcDir = path.join(appDir, 'src');
const webDir = path.join(appDir, 'dist/web');

function files(dir: string, pattern: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full, pattern);
    return pattern.test(entry.name) ? [full] : [];
  });
}

/** The code without its comments (which may name what the code must never do). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const sources = files(srcDir, /\.tsx?$/).map((file) => ({
  file: path.relative(appDir, file),
  text: code(fs.readFileSync(file, 'utf8')),
}));

describe('the dashboard writes only its own session and passkeys (AC1; U05, U06)', () => {
  it('only src/api/client.ts calls fetch; writes only through send, from src/api/writes.ts', () => {
    const callers = sources.filter((s) => /\bfetch\s*\(/.test(s.text)).map((s) => s.file);
    expect(callers).toEqual(['src/api/client.ts']);
    const client = sources.find((s) => s.file === 'src/api/client.ts')!.text;
    const methods = [...client.matchAll(/'(GET|POST|PUT|PATCH|DELETE)'/g)].map((m) => m[1]);
    expect(methods.filter((m) => m === 'PUT' || m === 'PATCH')).toEqual([]);
    // GETs go through getJson / getPublicJson only.
    expect([...client.matchAll(/request\(path, 'GET'/g)]).toHaveLength(2);
    // Writes: one `request` call, in `send`, with the cookie and the CSRF token (ADR-M73 §2.3).
    expect([...client.matchAll(/request\(path, method,/g)]).toHaveLength(1);
    expect(client).toContain(
      'const answer = await request(path, method, { cookie: true }, { csrf, body });',
    );
    expect(client).toContain("if (write) headers['x-sdlc-csrf'] = write.csrf;");
    expect(client).toContain(
      "if (write?.body !== undefined) headers['content-type'] = 'application/json';",
    );
    for (const { file, text } of sources) {
      if (file === 'src/api/writes.ts' || file === 'src/api/client.ts') continue;
      expect(text, file).not.toMatch(/\bsend\(/);
    }
  });

  it('the writes are exactly sign-out and the own passkeys: no business path', () => {
    const writes = sources.find((s) => s.file === 'src/api/writes.ts')!.text;
    const calls = [
      ...writes.matchAll(/send\(\s*apiPath\([`']([^`']+)[`']\),\s*'(POST|DELETE)'/g),
    ].map((m) => `${m[2]} ${m[1]!.replace(/\$\{[^}]+\}/g, 'X')}`);
    expect(calls.sort()).toEqual(
      [
        'POST /v1/auth/sign-out',
        'DELETE /v1/me/sessions',
        'POST /v1/me/passkeys/registration-options',
        'POST /v1/me/passkeys',
        'DELETE /v1/me/passkeys/X',
      ].sort(),
    );
    expect([...writes.matchAll(/\bsend\(/g)]).toHaveLength(calls.length);
  });

  it('U06: the CSRF token stays in memory; the passkey ceremony runs in the browser', () => {
    const session = sources.find((s) => s.file === 'src/session.ts')!.text;
    expect(session).toMatch(/let csrf: string \| null = null;/);
    const view = sources.find((s) => s.file === 'src/views/Passkeys.tsx')!.text;
    expect(view).toContain("import { startRegistration } from '@simplewebauthn/browser';");
  });

  it('never sends a request any other way', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /XMLHttpRequest|navigator\.sendBeacon|new WebSocket|EventSource|<form[^>]*action=/,
      );
      if (file === 'src/api/client.ts' || file === 'src/api/writes.ts') continue;
      expect(text, file).not.toMatch(/'(POST|PUT|PATCH|DELETE)'/);
    }
  });

  it('U05: the GitHub sign-in is a top-level navigation to the API, never a fetch', () => {
    const signIn = sources.find((s) => s.file === 'src/views/SignIn.tsx')!.text;
    expect(signIn).toContain('window.location.assign(gitHubSignInUrl(tenant))');
    const reads = sources.find((s) => s.file === 'src/api/reads.ts')!.text;
    expect(reads).toContain("apiPath('/v1/auth/github/start', { tenant })");
    // The session cookie is HttpOnly: the code never reads or writes cookies.
    for (const { file, text } of sources) expect(text, file).not.toMatch(/document\.cookie/);
    // A token or the cookie, never both: the Authorization header only with a token.
    const client = sources.find((s) => s.file === 'src/api/client.ts')!.text;
    expect(client).toContain("if ('token' in credential) headers.authorization");
    expect(client).toContain("credentials: 'cookie' in credential ? 'same-origin' : 'omit'");
    // A write keeps its Origin header (no `no-referrer` on POST or DELETE: review of PR 2).
    expect(client).toContain("referrerPolicy: method === 'GET' ? 'no-referrer' : 'same-origin'");
  });

  it('builds API paths only under /v1/ and only through apiPath', () => {
    for (const { file, text } of sources) {
      if (file === 'src/api/client.ts') continue;
      expect(text, file).not.toMatch(/getJson\(\s*['`]/);
    }
  });
});

describe('the token stays in memory (AC2)', () => {
  it('no browser storage, cookie or URL carries it', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(text, file).not.toMatch(/console\.(log|info|debug|warn|error)/);
    }
    const session = sources.find((s) => s.file === 'src/session.ts')!.text;
    expect(session).toMatch(/let token: string \| null = null;/);
    // The token goes in the Authorization header only, never in a query or a hash.
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/[?&]token=|#.*token/);
    }
  });
});

describe('no HTML injection; server text as text (AC5)', () => {
  it('never sets HTML from strings', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(
        /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/,
      );
      expect(text, file).not.toMatch(/\beval\(|new Function\(/);
    }
  });

  it('every dashboard key used in the source exists in the catalog', () => {
    const en = JSON.parse(
      fs.readFileSync(path.join(root, 'platform/packages/messages/src/locales/en.json'), 'utf8'),
    ) as Record<string, string>;
    const used = new Set(
      sources.flatMap((s) =>
        [...s.text.matchAll(/['"](dashboard\.[a-z0-9_.]+)['"]/g)].map((m) => m[1]!),
      ),
    );
    expect(used.size).toBeGreaterThan(100);
    expect([...used].filter((key) => !(key in en))).toEqual([]);
  });

  it('no user-facing English in JSX text outside the catalog', () => {
    for (const { file, text } of sources.filter((s) => s.file.endsWith('.tsx'))) {
      // Text nodes between tags that hold letters (codes like "v" before a number are allowed).
      const literal = [...text.matchAll(/>\s*([A-Za-z][A-Za-z ,.'!?-]{2,})\s*</g)].map((m) => m[1]);
      expect(literal, file).toEqual([]);
    }
  });
});

const built = fs.existsSync(path.join(webDir, 'index.html'));

describe.runIf(built)('the build (AC3, `pnpm build` first)', () => {
  const html = built ? fs.readFileSync(path.join(webDir, 'index.html'), 'utf8') : '';
  const assets = built ? files(path.join(webDir, 'assets'), /./) : [];

  it('has no inline script or style and loads nothing from another origin', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
    for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      expect(url, url).toMatch(/^(\/dashboard\/|\.\/)/);
    }
    for (const css of assets.filter((f) => f.endsWith('.css'))) {
      for (const [, url] of fs.readFileSync(css, 'utf8').matchAll(/url\(([^)]+)\)/g)) {
        expect(url, url).toMatch(/^["']?(\/dashboard\/|\.\/)/);
      }
    }
  });

  it('holds only file types the api serves, and no data: URI', () => {
    for (const file of files(webDir, /./)) {
      expect(path.extname(file), file).toMatch(/^\.(html|js|css|woff2|svg)$/);
    }
    for (const file of assets.filter((f) => /\.(js|css)$/.test(f))) {
      expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(/url\(\s*["']?data:/);
    }
  });

  it('stays within its budget: under 80 kB of JavaScript gzipped', () => {
    const js = assets
      .filter((f) => f.endsWith('.js'))
      .reduce((n, f) => n + gzipSync(fs.readFileSync(f)).length, 0);
    expect(js).toBeLessThan(80 * 1024);
  });
});
