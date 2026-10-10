// D-08 V12 (RELEASING.md, QUESTIONS #364, #370, #390): the release process.
// - platform/tools/release/release-check.mjs, the one release gate, on fixtures (AC2);
// - every CHANGELOG release section from 0.1.1 on has "Upgrade notes" (AC3; 0.1.0 is exempt);
// - release.yml: only a pushed tag, verifies the images (built before the tag) instead of
//   building them, creates the GitHub Release, the least permissions per job (AC2);
// - npm-publish.yml keeps its trusted-publisher identity and runs the same gate;
// - `pnpm release:lock` copies a release-images run's lock file, with a fake `gh`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { repoRoot } from './helpers';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, { tags?: string[] } | null>;
  permissions: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const root = repoRoot();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const CHECK = path.join(root, 'platform/tools/release/release-check.mjs');
const LOCK = path.join(root, 'platform/tools/release/lock.mjs');
const PREFIX = 'ghcr.io/hoanghainh1188/agentic-sdlc-framework';
const SIGNER =
  'https://github.com/hoanghainh1188/agentic-sdlc-framework/.github/workflows/release-images.yml@refs/heads/main';
const IMAGES: Record<string, string> = {
  API: 'sdlc-api',
  WORKER: 'sdlc-worker',
  RUNNER: 'sdlc-runner',
  OTEL_COLLECTOR: 'sdlc-otel-collector',
  SANDBOX_NODE24: 'sandbox-node24',
};

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-release-test-'));
  temps.push(dir);
  return dir;
}

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
function lockText(version: string, overrides: Record<string, string | null> = {}): string {
  const lines = ['# fixture', `SDLC_IMAGES_VERSION=${version}`];
  Object.entries(IMAGES).forEach(([key, image], i) => {
    const name = `SDLC_IMAGE_${key}`;
    const value = name in overrides ? overrides[name] : `${PREFIX}/${image}@${digest(i + 1)}`;
    if (value !== null) lines.push(`${name}=${value}`);
  });
  return lines.join('\n') + '\n';
}
const NOTES = '### Upgrade notes\n- No migration, no changed setting.\n';
const changelog = (version: string, section = NOTES) =>
  `# Changelog\n\n## [Unreleased]\n\n### Added\n- next\n\n## [${version}] - 2026-10-11\n\nIntro.\n\n${section}\n### Added\n- something\n\n## [0.1.0] - 2026-10-10\n\n### Added\n- first\n`;

interface Fixture {
  pkg?: string;
  platform?: string;
  changelog?: string;
  lock?: string;
}
function fixture(version: string, f: Fixture = {}): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'platform/apps/cli/src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'platform/deploy'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: f.pkg ?? version }));
  fs.writeFileSync(
    path.join(dir, 'platform/apps/cli/src/version.ts'),
    `export const PLATFORM_VERSION = '${f.platform ?? version}';\n`,
  );
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), f.changelog ?? changelog(version));
  fs.writeFileSync(path.join(dir, 'platform/deploy/images.lock'), f.lock ?? lockText(version));
  return dir;
}
function check(args: string[]) {
  const r = spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const tagCheck = (dir: string, tag: string, extra: string[] = []) =>
  check(['tag', tag, '--root', dir, ...extra]);

describe('V12: release-check.mjs, the release gate', () => {
  it('accepts a complete release and writes the notes and the five image references', () => {
    const dir = fixture('0.1.2');
    const notes = path.join(dir, 'notes.md');
    const images = path.join(dir, 'images.txt');
    const r = tagCheck(dir, 'v0.1.2', ['--notes-out', notes, '--images-out', images]);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out).toBe('release-check: v0.1.2 ok\n');
    const body = fs.readFileSync(notes, 'utf8');
    expect(body.startsWith('Intro.')).toBe(true);
    expect(body).toContain('### Upgrade notes');
    expect(body).not.toContain('## [');
    expect(body).not.toContain('first');
    const refs = fs.readFileSync(images, 'utf8').trim().split('\n');
    expect(refs).toHaveLength(5);
    for (const ref of refs)
      expect(ref).toMatch(new RegExp(`^${PREFIX}/[a-z0-9-]+@sha256:[0-9a-f]{64}$`));
  });

  it.each(['0.1.2', 'v0.1', 'v0.1.2-rc.1', 'v01.1.2', 'version', ''])(
    'refuses the tag "%s"',
    (tag) => {
      const r = tagCheck(fixture('0.1.2'), tag);
      expect(r.status).toBe(1);
      expect(r.err).toContain('tag_invalid');
    },
  );

  it('refuses a tag that differs from package.json or PLATFORM_VERSION, and names both', () => {
    let r = tagCheck(fixture('0.1.2', { pkg: '0.1.1' }), 'v0.1.2');
    expect(r.status).toBe(1);
    expect(r.err).toContain('package_version');
    r = tagCheck(fixture('0.1.2', { platform: '0.1.1' }), 'v0.1.2');
    expect(r.status).toBe(1);
    expect(r.err).toContain('platform_version');
    expect(r.out).toBe('');
  });

  it('refuses a missing, repeated or undated CHANGELOG section', () => {
    let r = tagCheck(fixture('0.1.2', { changelog: changelog('0.1.3') }), 'v0.1.2');
    expect(r.err).toContain('changelog_section_missing');
    const twice = changelog('0.1.2') + '\n## [0.1.2] - 2026-10-12\n\n' + NOTES;
    r = tagCheck(fixture('0.1.2', { changelog: twice }), 'v0.1.2');
    expect(r.err).toContain('changelog_section_twice');
    r = tagCheck(
      fixture('0.1.2', {
        changelog: changelog('0.1.2').replace('0.1.2] - 2026-10-11', '0.1.2] - soon'),
      }),
      'v0.1.2',
    );
    expect(r.err).toContain('changelog_date');
  });

  it('refuses a section without Upgrade notes, or with empty ones', () => {
    let r = tagCheck(fixture('0.1.2', { changelog: changelog('0.1.2', '') }), 'v0.1.2');
    expect(r.status).toBe(1);
    expect(r.err).toContain('upgrade_notes_missing');
    r = tagCheck(
      fixture('0.1.2', { changelog: changelog('0.1.2', '### Upgrade notes\n\n') }),
      'v0.1.2',
    );
    expect(r.status).toBe(1);
    expect(r.err).toContain('upgrade_notes_empty');
  });

  it('0.1.0, the first release, needs no Upgrade notes; every later one does', () => {
    const dir = fixture('0.1.2');
    expect(check(['changelog', '0.1.0', '--root', dir]).status).toBe(0);
    expect(check(['changelog', '0.1.2', '--root', dir]).status).toBe(0);
  });

  it('refuses images.lock for another version, with a tag, a missing image, another registry or an extra key', () => {
    const cases: [string, string][] = [
      [lockText('0.1.1'), 'lock_version'],
      [lockText('0.1.2', { SDLC_IMAGE_API: `${PREFIX}/sdlc-api:0.1.2` }), 'lock_image'],
      [lockText('0.1.2', { SDLC_IMAGE_RUNNER: null }), 'lock_image'],
      [
        lockText('0.1.2', { SDLC_IMAGE_WORKER: `docker.io/x/sdlc-worker@${digest(9)}` }),
        'lock_image',
      ],
      [lockText('0.1.2', { SDLC_IMAGE_API: `${PREFIX}/sdlc-worker@${digest(9)}` }), 'lock_image'],
      [lockText('0.1.2') + 'SDLC_IMAGE_EXTRA=x\n', 'lock_unknown'],
      ['', 'lock_version'],
    ];
    for (const [lock, code] of cases) {
      const r = tagCheck(fixture('0.1.2', { lock }), 'v0.1.2');
      expect(r.status, code).toBe(1);
      expect(r.err).toContain(code);
    }
  });

  it('lists every problem at once and writes no output file when it refuses', () => {
    const dir = fixture('0.1.2', {
      pkg: '0.1.1',
      lock: lockText('0.1.1'),
      changelog: changelog('0.1.2', ''),
    });
    const notes = path.join(dir, 'notes.md');
    const r = tagCheck(dir, 'v0.1.2', ['--notes-out', notes]);
    expect(r.status).toBe(1);
    for (const code of ['package_version', 'upgrade_notes_missing', 'lock_version'])
      expect(r.err).toContain(code);
    expect(fs.existsSync(notes)).toBe(false);
  });

  it('refuses unknown modes and missing values', () => {
    expect(check([]).status).toBe(1);
    expect(check(['publish', 'v1.0.0']).err).toContain('usage');
    expect(check(['tag', 'v1.0.0', '--root']).err).toContain('usage');
  });
});

describe('V12 AC3: the real CHANGELOG', () => {
  const text = read('CHANGELOG.md');
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.startsWith('## [0.1.0] - '));

  it('every release heading since 0.1.0 is "## [X.Y.Z] - YYYY-MM-DD" (or [Unreleased])', () => {
    expect(first).toBeGreaterThan(0);
    for (const line of lines.slice(0, first).filter((l) => l.startsWith('## '))) {
      expect(line).toMatch(/^## (\[Unreleased\]|\[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2})$/);
    }
  });

  const versions = lines
    .slice(0, first + 1)
    .flatMap((l) => /^## \[(\d+\.\d+\.\d+)\] - /.exec(l)?.[1] ?? []);
  it.each(versions)(
    'the section %s passes the release gate (Upgrade notes from 0.1.1 on)',
    (version) => {
      const r = check(['changelog', version, '--root', root]);
      expect(r.err).toBe('');
      expect(r.status).toBe(0);
    },
  );

  it('the current version of package.json has a section once it is released', () => {
    const pkg = (JSON.parse(read('package.json')) as { version: string }).version;
    expect(versions).toContain(pkg);
  });
});

describe('V12 AC2: release.yml', () => {
  const wf = parse(read('.github/workflows/release.yml')) as Workflow;
  const job = (name: string): Job => {
    const found = wf.jobs[name];
    if (!found) throw new Error(`release.yml has no job "${name}"`);
    return found;
  };
  const runs = (j: Job) => j.steps.map((s) => s.run ?? '').join('\n');

  it('runs only on a pushed tag v*: never by hand, on a branch or a pull request', () => {
    expect(wf.on).toEqual({ push: { tags: ['v*'] } });
  });

  it('only reads by default; packages and attestations read for the check; contents write for the release only', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(wf.jobs).sort()).toEqual(['check', 'release', 'verify-images']);
    expect(job('check').permissions).toBeUndefined();
    expect(job('verify-images').permissions).toEqual({
      contents: 'read',
      packages: 'read',
      attestations: 'read',
    });
    expect(job('release').permissions).toEqual({ contents: 'write' });
  });

  it('every job runs the release gate on the tag, and the tagged commit must be on main', () => {
    for (const name of Object.keys(wf.jobs)) {
      expect(runs(job(name))).toContain('node platform/tools/release/release-check.mjs tag "$TAG"');
      const gate = job(name).steps.find((s) => s.run?.includes('release-check.mjs'));
      expect(gate?.env?.TAG).toBe('${{ github.ref_name }}');
    }
    expect(runs(job('check'))).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
  });

  it('builds and pushes nothing: the images were built before the tag (QUESTIONS #370)', () => {
    const all = Object.values(wf.jobs).flatMap((j) => j.steps);
    for (const step of all) {
      expect(step.uses ?? '').not.toMatch(/build-push-action|release-images/);
      expect(step.run ?? '').not.toMatch(
        /docker (build|push)|buildx|git push|npm publish|cosign sign/,
      );
    }
  });

  it('verifies every image with the exact signer of release-images.yml on main', () => {
    expect(wf.env?.SIGNER_IDENTITY).toBe(SIGNER);
    expect(wf.env?.SIGNER_ISSUER).toBe('https://token.actions.githubusercontent.com');
    // Continuation lines joined, so the test reads one command per line.
    const text = runs(job('verify-images')).replace(/\s*\\\n\s*/g, ' ');
    expect(text).toContain(
      'cosign verify --certificate-identity "$SIGNER_IDENTITY" --certificate-oidc-issuer "$SIGNER_ISSUER" "$ref"',
    );
    expect(text).toContain(
      '--cert-identity "$SIGNER_IDENTITY" --cert-oidc-issuer "$SIGNER_ISSUER"',
    );
    expect(text).not.toMatch(/regexp/);
    expect(text).toContain('expected five images');
  });

  it('the release comes after both checks, from the CHANGELOG section, and never changes an existing one', () => {
    expect(job('verify-images').needs).toBe('check');
    expect(job('release').needs).toEqual(['check', 'verify-images']);
    const text = runs(job('release'));
    expect(text).toContain('--notes-out "$RUNNER_TEMP/notes.md"');
    expect(text).toContain('gh release view "$TAG"');
    expect(text).toContain('gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --verify-tag');
    expect(text).not.toMatch(/gh release (edit|delete|upload)|--clobber|--draft/);
  });

  it('checkouts never keep the token', () => {
    for (const j of Object.values(wf.jobs)) {
      for (const step of j.steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
        expect(step.with?.['persist-credentials']).toBe(false);
      }
    }
  });
});

describe('V12: npm-publish.yml keeps its trusted-publisher identity and shares the gate', () => {
  const wf = parse(read('.github/workflows/npm-publish.yml')) as Workflow;
  const publish = wf.jobs.publish!;

  it('the file, the trigger and the environment npm are unchanged (npm names them)', () => {
    expect(fs.existsSync(path.join(root, '.github/workflows/npm-publish.yml'))).toBe(true);
    expect(wf.on).toEqual({ push: { tags: ['v*'] } });
    expect(publish.environment).toBe('npm');
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('runs release-check.mjs on the tag before it builds the package', () => {
    const gate = publish.steps.findIndex((s) => s.run?.includes('release-check.mjs tag "$TAG"'));
    const build = publish.steps.findIndex((s) => s.run?.includes('cli:pack-check'));
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(build);
  });
});

describe('V12: pnpm release:lock', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

  it('is the root script', () => {
    expect(pkg.scripts['release:lock']).toBe('node platform/tools/release/lock.mjs');
  });

  interface Run {
    workflowName?: string;
    headBranch?: string;
    event?: string;
    status?: string;
    conclusion?: string;
  }
  // A fake `gh` on PATH: `run view` prints RUN_JSON, `run download` copies ARTIFACT into --dir.
  function runLock(run: Run, artifact: string | null, args = ['123']) {
    const dir = fixture('0.1.2', { lock: '# old\n' });
    const bin = tempDir();
    const art = path.join(bin, 'artifact.lock');
    if (artifact !== null) fs.writeFileSync(art, artifact);
    const json = JSON.stringify({
      workflowName: 'release-images',
      headBranch: 'main',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      ...run,
    });
    fs.writeFileSync(path.join(bin, 'run.json'), json);
    fs.writeFileSync(
      path.join(bin, 'gh'),
      [
        '#!/bin/sh',
        'echo "$@" >> "$FAKE_GH_DIR/calls"',
        'if [ "$1 $2" = "run view" ]; then cat "$FAKE_GH_DIR/run.json"; exit 0; fi',
        'if [ "$1 $2" = "run download" ]; then',
        '  while [ $# -gt 0 ]; do [ "$1" = --dir ] && out="$2"; shift; done',
        '  [ -f "$FAKE_GH_DIR/artifact.lock" ] && cp "$FAKE_GH_DIR/artifact.lock" "$out/images.lock"; exit 0',
        'fi',
        'exit 2',
      ].join('\n'),
      { mode: 0o755 },
    );
    const r = spawnSync(process.execPath, [LOCK, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_GH_DIR: bin },
    });
    const calls = fs.existsSync(path.join(bin, 'calls'))
      ? fs.readFileSync(path.join(bin, 'calls'), 'utf8')
      : '';
    return {
      status: r.status,
      err: r.stderr,
      calls,
      lock: fs.readFileSync(path.join(dir, 'platform/deploy/images.lock'), 'utf8'),
    };
  }

  it('copies the lock file of a successful release-images run on main', () => {
    const r = runLock({}, lockText('0.1.2'));
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.lock).toBe(lockText('0.1.2'));
    expect(r.calls).toContain(
      'run download 123 --repo hoanghainh1188/agentic-sdlc-framework --name images-lock-0.1.2',
    );
    expect(r.calls).not.toMatch(/workflow run|release create|pr create/);
  });

  it.each<[Run, string]>([
    [{ workflowName: 'ci' }, 'not release-images'],
    [{ headBranch: 'task/x' }, 'not main'],
    [{ event: 'workflow_call' }, 'not a person'],
    [{ conclusion: 'failure' }, 'not completed/success'],
    [{ status: 'in_progress' }, 'not completed/success'],
  ])('refuses the run %o', (run, message) => {
    const r = runLock(run, lockText('0.1.2'));
    expect(r.status).toBe(1);
    expect(r.err).toContain(message);
    expect(r.lock).toBe('# old\n');
  });

  it('refuses a lock file for another version, or no lock file, and keeps the old one', () => {
    let r = runLock({}, lockText('0.1.1'));
    expect(r.status).toBe(1);
    expect(r.lock).toBe('# old\n');
    r = runLock({}, null);
    expect(r.status).toBe(1);
    expect(r.err).toContain('holds no images.lock');
  });

  it('needs exactly one numeric run ID', () => {
    for (const args of [[], ['abc'], ['1', '2']]) {
      const r = runLock({}, lockText('0.1.2'), args);
      expect(r.status).toBe(1);
      expect(r.err).toContain('usage');
      expect(r.calls).toBe('');
    }
  });
});
