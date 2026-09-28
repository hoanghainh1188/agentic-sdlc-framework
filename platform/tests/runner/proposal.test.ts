// C06 session 2b (design/ADR-M33 §2.9, Harry's condition D1): the workspace archive from the
// sandbox is untrusted. Covers:
// - `untarWorkspace`: real archives from the system tar; hard links, devices, FIFOs, path escapes,
//   bad checksums, truncated data and the caps are refused; `.git` paths are skipped;
// - `mirrorWorkspace`: deletions are mirrored, `.git` is never touched, links are created as links
//   and never followed, nothing is written through a link;
// - `computeProposal`: hardened git in a real repository (the repository's own hooks and fsmonitor
//   never run), a binary patch that applies at `base_sha`;
// - `exportWorkspace`: the archive is read only from the run's own sandbox (name and labels).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  computeProposal,
  DockerClient,
  exportWorkspace,
  mirrorWorkspace,
  packTar,
  RunnerError,
  runnerSettingsFromEnv,
  untarWorkspace,
  type WorkspaceEntry,
} from '../../apps/runner/src/index.js';
import { runLabels, runNames } from '../../apps/runner/src/names.js';
import { StubDocker } from './stub-docker.js';

const LIMITS = { maxBytes: 1024 * 1024, maxEntries: 1000 };

/** One ustar header (checksum computed). */
function header(name: string, type: string, size = 0, link = ''): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write(link, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

function tar(...parts: Buffer[]): Buffer {
  return Buffer.concat([...parts, Buffer.alloc(1024, 0)]);
}

function data(content: string): Buffer {
  const b = Buffer.from(content);
  return Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512, 0)]);
}

const errorKey = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof RunnerError ? error.key : 'other';
  }
  return undefined;
};

const asyncKey = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return error instanceof RunnerError ? error.key : 'other';
  }
  return undefined;
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-proposal-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('untarWorkspace: the archive is untrusted', () => {
  it('reads an archive of the system tar: directories, files, the executable bit, links as links', async () => {
    const root = path.join(tmp, 'workspace');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'post-checkout'), 'evil');
    fs.symlinkSync('/etc/passwd', path.join(root, 'passwd'));
    const long = `${'d'.repeat(120)}/${'f'.repeat(120)}.txt`;
    fs.mkdirSync(path.join(root, path.dirname(long)), { recursive: true });
    fs.writeFileSync(path.join(root, long), 'long');
    // bsdtar on macOS adds AppleDouble `._*` files unless told not to; Docker never does.
    const archive = execFileSync('tar', ['-cf', '-', '-C', tmp, 'workspace'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });

    const entries = await untarWorkspace(archive, 'workspace', LIMITS);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get('src')).toEqual({ type: 'dir', path: 'src' });
    expect(byPath.get('src/a.ts')).toMatchObject({ type: 'file', executable: false });
    expect((byPath.get('src/a.ts') as { content: Buffer }).content.toString()).toBe(
      'export const a = 1;\n',
    );
    expect(byPath.get('run.sh')).toMatchObject({ type: 'file', executable: true });
    expect(byPath.get('passwd')).toEqual({
      type: 'symlink',
      path: 'passwd',
      target: '/etc/passwd',
    });
    expect((byPath.get(long) as { content: Buffer }).content.toString()).toBe('long');
    // The agent's `.git` is never read.
    expect(entries.some((e) => e.path.split('/').includes('.git'))).toBe(false);
  });

  it.each([
    ['a hard link', header('workspace/x', '1', 0, 'workspace/y')],
    ['a character device', header('workspace/tty', '3')],
    ['a block device', header('workspace/disk', '4')],
    ['a FIFO', header('workspace/fifo', '6')],
    ['an unknown type', header('workspace/z', 'Z')],
  ])('refuses %s', async (_name, entry) => {
    expect(await asyncKey(untarWorkspace(tar(entry), 'workspace', LIMITS))).toBe(
      'runner.workspace.special_file',
    );
  });

  it.each([
    '/etc/passwd',
    'workspace/../etc/passwd',
    'workspace/a/../../x',
    'other/x',
    'workspace/a//b',
    'workspace/./x',
    'workspace/a\\b',
    'workspacex/y',
  ])('refuses the path %j', async (name) => {
    expect(await asyncKey(untarWorkspace(tar(header(name, '0')), 'workspace', LIMITS))).toBe(
      'runner.workspace.archive_invalid',
    );
  });

  it('skips `.git` in any case or with ignorable characters (case-insensitive file systems)', async () => {
    const archive = tar(
      header('workspace/.GIT/', '5'),
      header('workspace/.GIT/config', '0', 5),
      data('evil\n'),
      header('workspace/sub/.Git/HEAD', '0'),
      header('workspace/.g\u200cit/config', '0'),
      header('workspace/keep.txt', '0'),
    );
    expect((await untarWorkspace(archive, 'workspace', LIMITS)).map((e) => e.path)).toEqual([
      'keep.txt',
    ]);
  });

  it('refuses a bad checksum, truncated data and a missing end', async () => {
    const bad = header('workspace/x', '0');
    bad[0] = 0x78;
    expect(await asyncKey(untarWorkspace(tar(bad), 'workspace', LIMITS))).toBe(
      'runner.workspace.archive_invalid',
    );
    const truncated = Buffer.concat([header('workspace/x', '0', 4096), data('abc')]);
    expect(await asyncKey(untarWorkspace(truncated, 'workspace', LIMITS))).toBe(
      'runner.workspace.archive_invalid',
    );
    expect(await asyncKey(untarWorkspace(header('workspace/x', '0'), 'workspace', LIMITS))).toBe(
      'runner.workspace.archive_invalid',
    );
  });

  it('refuses a PAX path that escapes, even when the short name is fine', async () => {
    const record = (key: string, value: string) => {
      const body = ` ${key}=${value}\n`;
      let length = body.length + 1;
      while (`${String(length)}${body}`.length !== length) length += 1;
      return `${String(length)}${body}`;
    };
    const pax = record('path', 'workspace/../../etc/cron.d/x');
    const archive = tar(
      header('workspace/PaxHeader', 'x', Buffer.byteLength(pax)),
      data(pax),
      header('workspace/fine', '0'),
    );
    expect(await asyncKey(untarWorkspace(archive, 'workspace', LIMITS))).toBe(
      'runner.workspace.archive_invalid',
    );
  });

  it('caps the total size and the number of entries', async () => {
    const big = tar(header('workspace/a', '0', 600), data('x'.repeat(600)));
    expect(
      await asyncKey(untarWorkspace(big, 'workspace', { maxBytes: 500, maxEntries: 10 })),
    ).toBe('runner.workspace.too_large');
    const many = tar(...['a', 'b', 'c'].map((n) => header(`workspace/${n}`, '0')));
    expect(
      await asyncKey(untarWorkspace(many, 'workspace', { maxBytes: 500, maxEntries: 2 })),
    ).toBe('runner.workspace.too_large');
  });
});

describe('mirrorWorkspace', () => {
  const file = (p: string, content: string, executable = false): WorkspaceEntry => ({
    type: 'file',
    path: p,
    content: Buffer.from(content),
    executable,
  });

  it('makes the clone equal to the archive: deletions mirrored, .git kept, links not followed', () => {
    const clone = path.join(tmp, 'repo');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
    fs.mkdirSync(path.join(clone, 'old'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(clone, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(clone, 'old', 'gone.txt'), 'gone');
    fs.writeFileSync(path.join(clone, 'keep.txt'), 'before');
    // The clone has `lib` as a link out of the clone; the archive has `lib` as a directory.
    fs.symlinkSync(outside, path.join(clone, 'lib'));

    mirrorWorkspace(clone, [
      file('keep.txt', 'after'),
      { type: 'dir', path: 'lib' },
      file('lib/x.ts', 'x', true),
      { type: 'symlink', path: 'link', target: '/etc/passwd' },
    ]);

    expect(fs.readFileSync(path.join(clone, 'keep.txt'), 'utf8')).toBe('after');
    expect(fs.existsSync(path.join(clone, 'old'))).toBe(false);
    expect(fs.readFileSync(path.join(clone, '.git', 'HEAD'), 'utf8')).toContain('main');
    expect(fs.lstatSync(path.join(clone, 'lib')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(clone, 'lib', 'x.ts')).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readlinkSync(path.join(clone, 'link'))).toBe('/etc/passwd');
  });

  it('never writes into the real .git, whatever the case of the name (security review)', () => {
    const clone = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
    fs.writeFileSync(path.join(clone, '.git', 'config'), '[core]\n');
    for (const entries of [
      [{ type: 'dir', path: '.GIT' }, file('.GIT/config', '[alias]\n\tdiff = !touch /tmp/x\n')],
      [{ type: 'dir', path: '.Git' }],
      [file('.gIt', 'x')],
    ] as WorkspaceEntry[][]) {
      expect(errorKey(() => mirrorWorkspace(clone, entries))).toBe(
        'runner.workspace.archive_invalid',
      );
    }
    expect(fs.readFileSync(path.join(clone, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });

  it('refuses two paths that are one file on a case-insensitive file system', () => {
    const clone = path.join(tmp, 'repo');
    fs.mkdirSync(clone);
    expect(
      errorKey(() =>
        mirrorWorkspace(clone, [
          { type: 'dir', path: 'src' },
          file('src/a.ts', '1'),
          file('src/A.ts', '2'),
        ]),
      ),
    ).toBe('runner.workspace.archive_invalid');
    expect(fs.readdirSync(clone)).toEqual([]);
  });

  it('refuses to write under a link, or twice to one path', () => {
    const clone = path.join(tmp, 'repo');
    fs.mkdirSync(clone);
    expect(
      errorKey(() =>
        mirrorWorkspace(clone, [
          { type: 'symlink', path: 'etc', target: '/etc' },
          file('etc/cron', 'x'),
        ]),
      ),
    ).toBe('runner.workspace.archive_invalid');
    expect(errorKey(() => mirrorWorkspace(clone, [file('a', '1'), file('a', '2')]))).toBe(
      'runner.workspace.archive_invalid',
    );
    expect(errorKey(() => mirrorWorkspace(clone, [file('no-parent/a', '1')]))).toBe(
      'runner.workspace.archive_invalid',
    );
  });
});

describe('computeProposal: hardened git in the runner clone', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1' },
    }).toString();

  it('diffs the mirrored tree against base_sha; the patch applies; repository hooks never run', async () => {
    const repo = path.join(tmp, 'repo');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();

    // A tampered repository configuration: fsmonitor and hooks would run a program.
    const canary = path.join(tmp, 'canary');
    const script = path.join(tmp, 'evil.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
    git(repo, 'config', 'core.fsmonitor', script);
    git(repo, 'config', 'core.hooksPath', tmp);
    fs.copyFileSync(script, path.join(tmp, 'pre-commit'));

    mirrorWorkspace(repo, [
      { type: 'file', path: 'a.txt', content: Buffer.from('one\nchanged\n'), executable: false },
      { type: 'dir', path: 'img' },
      {
        type: 'file',
        path: 'img/logo.bin',
        content: Buffer.concat([Buffer.from([0, 1, 2, 0]), crypto.randomBytes(64)]),
        executable: false,
      },
    ]);
    const proposal = await computeProposal(repo, home, base, {
      timeoutMs: 30_000,
      maxPatchBytes: 1024 * 1024,
    });
    expect([...proposal.changedFiles].sort()).toEqual(['a.txt', 'b.txt', 'img/logo.bin']);
    expect(proposal.patch.toString()).toContain('GIT binary patch');
    expect(fs.existsSync(canary)).toBe(false);

    // The patch applies to a fresh checkout of base_sha.
    const check = path.join(tmp, 'check');
    execFileSync('git', ['clone', '-q', repo, check], {
      env: { PATH: process.env.PATH, HOME: tmp },
    });
    git(check, 'checkout', '-q', base);
    const patchFile = path.join(tmp, 'p.patch');
    fs.writeFileSync(patchFile, proposal.patch);
    git(check, 'apply', '--check', patchFile);
  });

  it('refuses a base that is not a full commit id', async () => {
    await expect(
      computeProposal(tmp, tmp, 'HEAD', { timeoutMs: 1000, maxPatchBytes: 1024 }),
    ).rejects.toMatchObject({ key: 'runner.workspace.proposal_failed' });
  });
});

describe('exportWorkspace: only the run own sandbox', () => {
  let stub: StubDocker;
  let docker: DockerClient;
  const RUN = '11111111-2222-4333-8444-555555555555';
  const TENANT = '99999999-2222-4333-8444-555555555555';

  beforeAll(async () => {
    stub = await StubDocker.start();
    docker = new DockerClient({ socketPath: stub.socketPath, timeoutMs: 5000 });
  });
  afterAll(async () => {
    await stub.stop();
  });
  beforeEach(() => {
    stub.containers.clear();
    stub.calls.length = 0;
  });

  const settings = () =>
    runnerSettingsFromEnv({ SDLC_RUNNER_DOCKER_SOCKET: '/var/run/docker.sock' });
  const archive = packTar([
    { type: 'dir', path: 'workspace' },
    { type: 'file', path: 'workspace/a.txt', content: Buffer.from('a') },
  ]);

  function container(name: string, labels: Record<string, string>) {
    stub.containers.set('c1', {
      id: 'c1',
      name,
      spec: { Labels: labels },
      running: true,
      archives: [],
      exported: archive,
    });
  }

  it('reads the archive of the run sandbox', async () => {
    container(runNames(RUN).container, runLabels(settings().instance, RUN, TENANT));
    const entries = await exportWorkspace(docker, settings(), RUN);
    expect(entries.map((e) => e.path)).toEqual(['a.txt']);
    expect(stub.trace).toContain(`GET /containers/${runNames(RUN).container}/archive`);
  });

  it.each([
    ['another instance', () => runLabels('other', RUN, TENANT)],
    ['another run', () => runLabels(settings().instance, TENANT, TENANT)],
    ['no labels', () => ({})],
  ])('refuses a container with %s, before reading any archive', async (_name, labels) => {
    container(runNames(RUN).container, labels());
    await expect(exportWorkspace(docker, settings(), RUN)).rejects.toMatchObject({
      key: 'runner.workspace.not_own_sandbox',
    });
    expect(stub.trace.some((c) => c.endsWith('/archive'))).toBe(false);
  });

  it('the Docker client reads archives of run sandboxes only, before the socket', async () => {
    for (const name of ['postgres', 'sdlc-sdlc-runner-1', `${runNames(RUN).container}x`]) {
      await expect(docker.getArchive(name, '/')).rejects.toBeInstanceOf(RunnerError);
    }
    expect(stub.calls).toEqual([]);
  });
});
