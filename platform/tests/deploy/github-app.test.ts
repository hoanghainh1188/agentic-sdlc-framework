// D-08 V03: `pnpm github-app:create` makes the GitHub App from a manifest. Against a fake GitHub
// only (a local HTTP server), never the real one:
// - manifest.json equals the README's permission table, row by row; webhook off, private, no events;
// - the local server listens on 127.0.0.1 only, its page has no script, the form posts to GitHub;
// - a wrong or missing state is refused; one valid callback, then the server closes; a time-out;
// - the key file is mode 600, outside the repository, never over a file without --force;
// - the private key, the client secret and the webhook secret never reach the output or a file
//   other than the key file.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { keepCredentials } from '../../deploy/github-app/src/convert.js';
import { parseManifest } from '../../deploy/github-app/src/manifest.js';
import { EXIT, runCreate, type RunDeps } from '../../deploy/github-app/src/run.js';
import { codeFromPaste, sameSecret } from '../../deploy/github-app/src/server.js';
import { repoRoot } from '../workspace/helpers.js';

const root = repoRoot();
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
const manifestFile = path.join(root, 'platform/deploy/github-app/manifest.json');

/** README permission names → the manifest's permission keys (GitHub's REST names). */
const PERMISSION_KEYS: Record<string, string> = {
  Contents: 'contents',
  Issues: 'issues',
  'Pull requests': 'pull_requests',
  'Code scanning alerts': 'security_events',
  Checks: 'checks',
  'Commit statuses': 'statuses',
  Metadata: 'metadata',
};
const LEVELS: Record<string, string> = { 'Read and write': 'write', 'Read-only': 'read' };

function readmePermissions(): Record<string, string> {
  const readme = read('platform/deploy/README.md');
  const start = readme.indexOf('<a id="github-app-permissions"></a>');
  const table = readme.slice(start, readme.indexOf('\n\n- ', start));
  const rows = [...table.matchAll(/^\| ([^|]+?) \| ([^|]+?) \| [^|]+ \|$/gm)].filter(
    ([, name]) => name !== 'Permission (repository)',
  );
  return Object.fromEntries(
    rows.map(([, name, level]) => [PERMISSION_KEYS[name!] ?? name!, LEVELS[level!] ?? level!]),
  );
}

describe('V03: the manifest', () => {
  const manifest = JSON.parse(read('platform/deploy/github-app/manifest.json')) as Record<
    string,
    unknown
  >;

  it('has exactly the README permissions, row by row', () => {
    const fromReadme = readmePermissions();
    expect(Object.keys(fromReadme)).toHaveLength(7);
    expect(manifest.default_permissions).toEqual(fromReadme);
  });

  it('keeps the webhook off, the App private, no events, no OAuth', () => {
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes).toMatchObject({ active: false });
    expect(manifest.default_events).toEqual([]);
    expect(manifest.request_oauth_on_install).toBe(false);
    expect(() => parseManifest(JSON.stringify(manifest))).not.toThrow();
  });

  it.each([
    ['public', { public: true }],
    ['webhook on', { hook_attributes: { url: 'https://example.invalid/x', active: true } }],
    ['events', { default_events: ['issues'] }],
    ['admin level', { default_permissions: { contents: 'admin' } }],
    ['a fixed redirect', { redirect_url: 'https://example.invalid/' }],
  ])('refuses a loosened manifest: %s', (_label, change) => {
    expect(() => parseManifest(JSON.stringify({ ...manifest, ...change }))).toThrow();
  });

  it('the script, the build and the documents use it', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['github-app:create']).toContain('platform/deploy/github-app/dist/main.js');
    expect(read('tsconfig.json')).toContain('"platform/deploy/github-app"');
    expect(read('platform/deploy/README.md')).toContain('pnpm github-app:create');
    expect(read('TRIAL.md')).toContain('pnpm github-app:create');
  });
});

// ---------------------------------------------------------------------------------------------
// The flow, against a fake GitHub.

interface FakeGitHub {
  readonly url: string;
  readonly codes: string[];
  status: number;
  close(): Promise<void>;
}

const secrets = {
  pem: `-----BEGIN RSA ${'PRIVATE'} KEY-----\n${randomBytes(48).toString('base64')}\n-----END RSA ${'PRIVATE'} KEY-----\n`,
  clientSecret: `cs${randomBytes(20).toString('hex')}`,
  webhookSecret: `wh${randomBytes(20).toString('hex')}`,
};

async function fakeGitHub(): Promise<FakeGitHub> {
  const codes: string[] = [];
  const state = { status: 201 };
  const server = http.createServer((req, res) => {
    const match = /^\/app-manifests\/([^/]+)\/conversions$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !match) {
      res.writeHead(404).end();
      return;
    }
    codes.push(decodeURIComponent(match[1]!));
    res.writeHead(state.status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 424242,
        slug: 'sdlc-test-app',
        client_id: 'Iv23liFAKEFAKE',
        client_secret: secrets.clientSecret,
        webhook_secret: secrets.webhookSecret,
        pem: secrets.pem,
        html_url: 'https://example.invalid/apps/sdlc-test-app',
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    codes,
    get status() {
      return state.status;
    },
    set status(value: number) {
      state.status = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Harness {
  readonly run: Promise<number>;
  readonly pageUrl: Promise<string>;
  readonly out: string[];
  readonly err: string[];
}

function start(argv: string[], extra: Partial<RunDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  let listening!: (url: string) => void;
  const pageUrl = new Promise<string>((resolve) => (listening = resolve));
  const run = runCreate(argv, {
    repoRoot: root,
    manifestFile,
    githubUrl: 'https://github.com',
    apiUrl: github.url,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    onListening: listening,
    ...extra,
  });
  return { run, pageUrl, out, err };
}

const unescape = (s: string): string =>
  s
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

async function openForm(pageUrl: string) {
  const res = await fetch(pageUrl);
  const html = await res.text();
  const action = unescape(/<form method="post" action="([^"]+)">/.exec(html)![1]!);
  const manifest = JSON.parse(
    unescape(/<input type="hidden" name="manifest" value="([^"]+)">/.exec(html)![1]!),
  ) as Record<string, unknown>;
  const state = new URL(action).searchParams.get('state')!;
  return { res, html, action, manifest, state };
}

const callback = (pageUrl: string, query: string) => fetch(new URL(`/callback?${query}`, pageUrl));

let github: FakeGitHub;
let dir: string;
let keyFile: string;

beforeEach(async () => {
  github = await fakeGitHub();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-github-app-'));
  keyFile = path.join(dir, 'app.pem');
});

afterEach(async () => {
  await github.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Every file under `dir` except the key file holds none of the three secrets. */
function expectNoSecretOutside(h: Harness): void {
  const text = [...h.out, ...h.err].join('\n');
  for (const value of [secrets.pem.split('\n')[1]!, secrets.clientSecret, secrets.webhookSecret])
    expect(text).not.toContain(value);
  for (const name of fs.readdirSync(dir)) {
    const content = fs.readFileSync(path.join(dir, name), 'utf8');
    if (name === 'app.pem') continue;
    expect(content).not.toContain(secrets.clientSecret);
  }
  if (fs.existsSync(keyFile)) {
    const key = fs.readFileSync(keyFile, 'utf8');
    expect(key).not.toContain(secrets.clientSecret);
    expect(key).not.toContain(secrets.webhookSecret);
  }
}

describe('V03: pnpm github-app:create against a fake GitHub', () => {
  it('serves a page without script on 127.0.0.1 and saves the key with mode 600', async () => {
    const h = start(['--out', keyFile, '--name', 'sdlc-test']);
    const pageUrl = await h.pageUrl;
    expect(pageUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const { res, html, action, manifest, state } = await openForm(pageUrl);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain('form-action https://github.com');
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(action).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=[A-Za-z0-9_-]{43}$/);
    expect(manifest).toMatchObject({
      name: 'sdlc-test',
      redirect_url: new URL('/callback', pageUrl).href,
      public: false,
      hook_attributes: { active: false },
    });

    const done = await callback(pageUrl, `code=abc123&state=${state}`);
    expect(done.status).toBe(200);
    expect(await h.run).toBe(EXIT.ok);
    expect(github.codes).toEqual(['abc123']);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(secrets.pem);
    expect(fs.readdirSync(dir)).toEqual(['app.pem']);
    const text = h.out.join('\n');
    expect(text).toContain('424242');
    expect(text).toContain('Iv23liFAKEFAKE');
    expect(text).toContain('https://github.com/apps/sdlc-test-app/installations/new');
    expectNoSecretOutside(h);
    // One callback, then the server is closed.
    await expect(fetch(pageUrl)).rejects.toThrow();
  });

  it('posts to the organization page with --org', async () => {
    const h = start(['--out', keyFile, '--org', 'acme-co']);
    const { action, state } = await openForm(await h.pageUrl);
    expect(action).toMatch(/^https:\/\/github\.com\/organizations\/acme-co\/settings\/apps\/new\?/);
    await callback(await h.pageUrl, `code=c1&state=${state}`);
    expect(await h.run).toBe(EXIT.ok);
  });

  it('refuses a wrong or missing state and keeps waiting for the right one', async () => {
    const h = start(['--out', keyFile]);
    const pageUrl = await h.pageUrl;
    const { state } = await openForm(pageUrl);
    expect((await callback(pageUrl, 'code=c1')).status).toBe(400);
    expect((await callback(pageUrl, `code=c1&state=${state.slice(1)}x`)).status).toBe(400);
    expect((await callback(pageUrl, `code=c1&state=${state}x`)).status).toBe(400);
    expect((await callback(pageUrl, `code=../x&state=${state}`)).status).toBe(400);
    expect(github.codes).toEqual([]);
    await callback(pageUrl, `code=good&state=${state}`);
    expect(await h.run).toBe(EXIT.ok);
    expect(github.codes).toEqual(['good']);
  });

  it('answers only its own Host (no DNS rebinding)', async () => {
    const h = start(['--out', keyFile], { timeoutMs: 2000 });
    const pageUrl = new URL(await h.pageUrl);
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port: pageUrl.port, path: '/', headers: { Host: 'evil.example' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        )
        .on('error', reject);
    });
    expect(status).toBe(404);
    expect(await h.run).toBe(EXIT.failed);
  });

  it('times out, closes the server and saves nothing', async () => {
    const h = start(['--out', keyFile], { timeoutMs: 100 });
    const pageUrl = await h.pageUrl;
    expect(await h.run).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain('15 minutes');
    expect(fs.existsSync(keyFile)).toBe(false);
    await expect(fetch(pageUrl)).rejects.toThrow();
  });

  it('takes a pasted address when the browser cannot reach 127.0.0.1 (QUESTIONS #350)', async () => {
    let pastes = 0;
    let listening!: (url: string) => void;
    const pageUrl = new Promise<string>((resolve) => (listening = resolve));
    const h = start(['--out', keyFile], {
      onListening: (url) => listening(url),
      readPasted: async () => {
        pastes += 1;
        if (pastes === 1) return 'not an address';
        const { state } = await openForm(await pageUrl);
        if (pastes === 2) return `http://127.0.0.1:1/callback?code=wrong&state=${state}x`;
        return `http://127.0.0.1:1/callback?code=pasted1&state=${state}`;
      },
    });
    expect(await h.run).toBe(EXIT.ok);
    expect(pastes).toBe(3);
    expect(github.codes).toEqual(['pasted1']);
    expect(h.err.filter((line) => line.includes('wrong or missing state'))).toHaveLength(2);
    expectNoSecretOutside(h);
  });

  it('stops when the person cancels the paste prompt', async () => {
    const h = start(['--out', keyFile], {
      readPasted: () => Promise.reject(new Error('cancelled')),
    });
    expect(await h.run).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain('Cancelled');
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it('refuses --out inside the repository before it starts', async () => {
    const h = start(['--out', path.join(root, 'platform/app.pem')]);
    expect(await h.run).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain('inside the repository');
  });

  it('refuses a case variant of the repository path on macOS and Windows', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    const h = start(['--out', path.join(root.toUpperCase(), 'platform', 'app.pem')]);
    expect(await h.run).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain('inside the repository');
  });

  it('answers a malformed request target with 400 and keeps running', async () => {
    const h = start(['--out', keyFile]);
    const pageUrl = new URL(await h.pageUrl);
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port: pageUrl.port, path: '//[::', headers: { Host: pageUrl.host } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        )
        .on('error', reject);
    });
    expect(status).toBe(400);
    const { state } = await openForm(pageUrl.href);
    await callback(pageUrl.href, `code=c3&state=${state}`);
    expect(await h.run).toBe(EXIT.ok);
  });

  it('refuses an existing file without --force, replaces it with --force', async () => {
    fs.writeFileSync(keyFile, 'old', { mode: 0o644 });
    const refused = start(['--out', keyFile]);
    expect(await refused.run).toBe(EXIT.failed);
    expect(refused.err.join('\n')).toContain('--force');

    const h = start(['--out', keyFile, '--force']);
    const { state } = await openForm(await h.pageUrl);
    await callback(await h.pageUrl, `code=c2&state=${state}`);
    expect(await h.run).toBe(EXIT.ok);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(secrets.pem);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('never writes through a link, even with --force', async () => {
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, keyFile);
    const h = start(['--out', keyFile, '--force']);
    expect(await h.run).toBe(EXIT.failed);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
  });

  it('saves nothing when GitHub refuses the code, and prints no answer text', async () => {
    github.status = 422;
    const h = start(['--out', keyFile]);
    const { state } = await openForm(await h.pageUrl);
    await callback(await h.pageUrl, `code=used&state=${state}`);
    expect(await h.run).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain('HTTP 422');
    expect(fs.existsSync(keyFile)).toBe(false);
    expectNoSecretOutside(h);
  });

  it('shows the usage without --out, and refuses a bad --org or --name', async () => {
    expect(await start([]).run).toBe(EXIT.usage);
    expect(await start(['--out', keyFile, '--org', 'bad org']).run).toBe(EXIT.usage);
    expect(await start(['--out', keyFile, '--name', 'x'.repeat(35)]).run).toBe(EXIT.usage);
    expect(await start(['--out', keyFile, '--bogus']).run).toBe(EXIT.usage);
  });
});

describe('V03: the pieces', () => {
  it('compares the state in constant time and refuses other lengths', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });

  it('reads a pasted address only with this run’s state', () => {
    expect(codeFromPaste('http://127.0.0.1:9/callback?code=k1&state=s1', 's1')).toBe('k1');
    expect(codeFromPaste('http://127.0.0.1:9/callback?code=k1&state=s2', 's1')).toBeUndefined();
    expect(codeFromPaste('  k1  ', 's1')).toBe('k1');
    // The state pasted by mistake is never sent to GitHub as a code.
    expect(codeFromPaste('s1', 's1')).toBeUndefined();
    expect(codeFromPaste('http://127.0.0.1:9/callback?code=a/b&state=s1', 's1')).toBeUndefined();
  });

  it('keeps id, client ID, slug and key only', () => {
    const kept = keepCredentials({
      id: 1,
      client_id: 'Iv1',
      slug: 's',
      pem: secrets.pem,
      client_secret: secrets.clientSecret,
      webhook_secret: secrets.webhookSecret,
    });
    expect(Object.keys(kept).sort()).toEqual(['clientId', 'id', 'pem', 'slug']);
    expect(JSON.stringify(kept)).not.toContain(secrets.clientSecret);
    expect(() => keepCredentials({ id: 1, client_id: 'Iv1', slug: 's', pem: 'x' })).toThrow();
  });
});
