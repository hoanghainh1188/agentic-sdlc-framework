// A local Git host for the runner tests (D-08 C04 AC2, ADR-M25 §2.1): git's own smart-HTTP server
// (`git http-backend`) behind a small Node HTTP server that requires the run token as GitHub does
// (`Authorization: basic x-access-token:<token>`). It records every request, so tests can check
// that the token was sent only as a header, never in the URL.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface GitRequest {
  readonly url: string;
  readonly authorized: boolean;
}

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

export class StubGitHost {
  readonly requests: GitRequest[] = [];
  /** The token the server accepts; change it to test a wrong or expired token. */
  token: string;

  private constructor(
    private readonly server: http.Server,
    readonly root: string,
    token: string,
  ) {
    this.token = token;
  }

  static async start(token: string): Promise<StubGitHost> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-stub-git-'));
    const holder: { host?: StubGitHost } = {};
    const server = http.createServer((req, res) => holder.host!.handle(req, res));
    const host = new StubGitHost(server, root, token);
    holder.host = host;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return host;
  }

  get origin(): string {
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  /**
   * Creates the bare repository `owner/name.git` with one commit holding `files`, plus a second
   * commit on top. Returns both commit SHAs (the first is a typical `base_sha`).
   */
  createRepo(
    repo: string,
    files: Readonly<Record<string, string>>,
    options: { executable?: string[]; symlinks?: Record<string, string> } = {},
  ): { first: string; second: string } {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-stub-git-work-'));
    try {
      git(work, 'init', '--quiet', '--initial-branch=main');
      for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
        fs.writeFileSync(path.join(work, name), content);
      }
      for (const name of options.executable ?? []) fs.chmodSync(path.join(work, name), 0o755);
      for (const [name, target] of Object.entries(options.symlinks ?? {})) {
        fs.symlinkSync(target, path.join(work, name));
      }
      git(work, 'add', '--all');
      git(work, 'commit', '--quiet', '-m', 'first');
      const first = git(work, 'rev-parse', 'HEAD');
      fs.writeFileSync(path.join(work, 'CHANGELOG.md'), 'second\n');
      git(work, 'add', '--all');
      git(work, 'commit', '--quiet', '-m', 'second');
      const second = git(work, 'rev-parse', 'HEAD');
      const bare = path.join(this.root, `${repo}.git`);
      fs.mkdirSync(path.dirname(bare), { recursive: true });
      git(work, 'clone', '--quiet', '--bare', work, bare);
      git(bare, 'config', 'http.receivepack', 'false');
      return { first, second };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * Imports an existing repository (for example a public one) as the bare `owner/name.git`.
   * Returns the commit of its default branch.
   */
  importRepo(repo: string, source: string): string {
    const bare = path.join(this.root, `${repo}.git`);
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    git(this.root, 'clone', '--quiet', '--bare', source, bare);
    git(bare, 'config', 'http.receivepack', 'false');
    return git(bare, 'rev-parse', 'HEAD');
  }

  /**
   * Lets the run token push to `owner/name.git` (C08). `protect`: branches the server refuses, like
   * GitHub's branch protection on the default branch (N6): a `pre-receive` hook rejects them.
   */
  allowPush(repo: string, options: { protect?: readonly string[] } = {}): void {
    const bare = path.join(this.root, `${repo}.git`);
    git(bare, 'config', 'http.receivepack', 'true');
    const refs = (options.protect ?? []).map((branch) => `refs/heads/${branch}`);
    const hook = path.join(bare, 'hooks', 'pre-receive');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'while read old new ref; do',
        ...refs.map((ref) => `  [ "$ref" = "${ref}" ] && { echo "protected branch" >&2; exit 1; }`),
        '  :',
        'done',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }

  /** The commit a branch of `owner/name.git` points to, or null. */
  branchHead(repo: string, branch: string): string | null {
    try {
      return git(
        path.join(this.root, `${repo}.git`),
        'rev-parse',
        '--verify',
        `refs/heads/${branch}`,
      );
    } catch {
      return null;
    }
  }

  /** Runs git in the bare repository `owner/name.git` (tests: read commits, move a branch). */
  gitIn(repo: string, ...args: string[]): string {
    return git(path.join(this.root, `${repo}.git`), ...args);
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const expected = `basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`;
    const authorized = (req.headers.authorization ?? '').toLowerCase() === expected.toLowerCase();
    this.requests.push({ url: req.url ?? '', authorized });
    if (!authorized) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="stub"' });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://stub');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...GIT_ENV,
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    cgi.on('close', () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf('\r\n\r\n');
      const head = out.subarray(0, split).toString('utf8');
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.split('\r\n')) {
        const [name, ...rest] = line.split(':');
        const value = rest.join(':').trim();
        if (name?.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else if (name) headers[name] = value;
      }
      res.writeHead(status, headers);
      res.end(out.subarray(split + 4));
    });
  }
}
