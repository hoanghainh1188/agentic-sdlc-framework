// D-08 V04 (design/ADR-M66): the platform's images on GHCR for a release.
// - the release workflow builds and scans the five images before any push, and only then pushes,
//   tags, signs and attests them; its thresholds equal ci.yml;
// - Compose uses the published images by digest on a release checkout (images.lock.env, the
//   overlay docker-compose.images.yml, scripts/images.sh) and builds locally everywhere else;
// - the README says how to verify them, with the identity the workflow signs with.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { loadCompose, parseEnvFile, readDeployFile, root } from './compose';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  strategy?: { matrix: Record<string, unknown> };
  steps: Step[];
}
interface Workflow {
  on: Record<string, { inputs?: Record<string, { type: string; default?: unknown }> }>;
  permissions: Record<string, string>;
  env: Record<string, string>;
  jobs: Record<string, Job>;
}
interface MatrixEntry {
  image: string;
  context: string;
  dockerfile: string;
  ignorefile: string;
}

const PREFIX = 'ghcr.io/hoanghainh1188/agentic-sdlc-framework';
const IMAGES = ['sdlc-api', 'sdlc-worker', 'sdlc-runner', 'sdlc-otel-collector', 'sandbox-node24'];
const LOCK_NAMES: Record<string, string> = {
  API: 'sdlc-api',
  WORKER: 'sdlc-worker',
  RUNNER: 'sdlc-runner',
  OTEL_COLLECTOR: 'sdlc-otel-collector',
  SANDBOX_NODE24: 'sandbox-node24',
};

const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const wf = parse(read('.github/workflows/release-images.yml')) as Workflow;
const ci = parse(read('.github/workflows/ci.yml')) as { env: Record<string, string> };
const readme = read('platform/deploy/README.md');
const pkgVersion = (JSON.parse(read('package.json')) as { version: string }).version;

function job(name: string): Job {
  const found = wf.jobs[name];
  if (!found) throw new Error(`release-images.yml has no job "${name}"`);
  return found;
}
const stepIndex = (j: Job, pred: (s: Step) => boolean) => j.steps.findIndex(pred);
const matrixEntries = () => job('build').strategy?.matrix.include as MatrixEntry[];

describe('V04: the release workflow', () => {
  it('runs only when called (V12) or started by a person, and pushes nothing by default', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
    for (const trigger of ['workflow_call', 'workflow_dispatch']) {
      const inputs = wf.on[trigger]?.inputs ?? {};
      expect(Object.keys(inputs).sort()).toEqual(['push', 'version']);
      expect(inputs.push).toMatchObject({ type: 'boolean', default: false });
    }
  });

  it('only reads by default; packages, id-token and attestations only where needed', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(job('check').permissions).toBeUndefined();
    expect(job('lock').permissions).toBeUndefined();
    expect(job('build').permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(job('publish').permissions).toEqual({
      contents: 'read',
      packages: 'write',
      'id-token': 'write',
      attestations: 'write',
    });
    expect(job('publish').if).toBe('inputs.push');
    expect(job('lock').if).toBe('inputs.push');
  });

  it('checks the version against package.json and pushes only from main or the release tag', () => {
    const run = job('check')
      .steps.map((s) => s.run ?? '')
      .join('\n');
    expect(run).toContain('jq -r .version package.json');
    expect(run).toContain('refs/heads/main | "refs/tags/v$VERSION"');
  });

  it('builds the five images for amd64 and arm64, each on a native runner', () => {
    const build = job('build');
    expect(build.strategy?.matrix.arch).toEqual(['amd64', 'arm64']);
    expect(build.strategy?.matrix.image).toEqual(IMAGES);
    expect(matrixEntries().map((e) => e.image)).toEqual(IMAGES);
    expect(job('publish').strategy?.matrix.image).toEqual(IMAGES);
    for (const e of matrixEntries()) {
      expect(fs.existsSync(path.join(root, e.dockerfile)), e.dockerfile).toBe(true);
      expect(fs.existsSync(path.join(root, e.ignorefile)), e.ignorefile).toBe(true);
    }
    expect(read('.github/workflows/release-images.yml')).toContain(
      "matrix.arch == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-24.04'",
    );
  });

  it('builds exactly what Compose builds (same Dockerfiles, same contexts)', () => {
    const compose = parse(readDeployFile('docker-compose.yml'), { merge: true }) as {
      services: Record<
        string,
        { image?: string; build?: { context: string; dockerfile?: string } }
      >;
    };
    const built = Object.entries(compose.services).filter(([, s]) => s.build);
    expect(built.length).toBe(4);
    for (const [, s] of built) {
      const name = s.image!.split(':')[0]!;
      const entry = matrixEntries().find((e) => e.image === name);
      expect(entry, name).toBeDefined();
      const context = path.relative(root, path.resolve(root, 'platform/deploy', s.build!.context));
      expect(entry!.context === '.' ? '' : entry!.context).toBe(context);
      const dockerfile = s.build!.dockerfile ?? path.join(context, 'Dockerfile');
      expect(entry!.dockerfile).toBe(dockerfile);
    }
  });

  it('keeps the Trivy version and thresholds of ci.yml, both archives checked by SHA-256', () => {
    for (const key of [
      'TRIVY_BLOCK_SEVERITY',
      'TRIVY_REPORT_SEVERITY',
      'TRIVY_VERSION',
      'TRIVY_SHA256',
    ])
      expect(wf.env[key], key).toBe(ci.env[key]);
    expect(wf.env.TRIVY_ARM64_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const install = job('build').steps.find((s) => s.name === 'Install trivy')?.run ?? '';
    expect(install).toContain('sha256sum -c -');
  });

  it('scans each image before anything is pushed, and pushes only with push: true', () => {
    const build = job('build');
    const local = stepIndex(build, (s) => s.name === 'Build (local, for the scan)');
    const scan = stepIndex(build, (s) => s.name === 'Trivy scan (severity CRITICAL blocks)');
    const push = stepIndex(build, (s) => s.name === 'Push by digest');
    expect(local).toBeGreaterThanOrEqual(0);
    expect(local).toBeLessThan(scan);
    expect(scan).toBeLessThan(push);
    expect(build.steps[local]?.with).toMatchObject({ load: true });
    expect(build.steps[local]?.with?.push).toBeUndefined();
    expect(build.steps[scan]?.run).toContain('--exit-code 1');
    for (const s of build.steps.filter((x) => x.uses?.startsWith('docker/login-action@')))
      expect(s.if).toBe('inputs.push');
    expect(build.steps[push]?.if).toBe('inputs.push');
    expect(build.steps[push]?.with).toMatchObject({ provenance: 'mode=max', sbom: true });
    expect(String(build.steps[push]?.with?.outputs)).toContain('push-by-digest=true');
  });

  it('never moves a tag, signs with cosign keyless and records a build provenance attestation', () => {
    const publish = job('publish');
    const text = publish.steps.map((s) => s.run ?? '').join('\n');
    expect(text).toContain('already exists');
    expect(text).toContain('cosign sign --yes');
    expect(text).not.toMatch(/--key\b/);
    expect(publish.steps.some((s) => s.uses?.startsWith('actions/attest-build-provenance@'))).toBe(
      true,
    );
    expect(wf.env.COSIGN_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('uses one registry path everywhere', () => {
    expect(wf.env.IMAGE_PREFIX).toBe(PREFIX);
    expect(readDeployFile('scripts/images.sh')).toContain(`PREFIX="${PREFIX}"`);
    expect(readme).toContain(PREFIX);
  });

  it('writes a lock file with the same names as platform/deploy/images.lock.env', () => {
    const run = job('lock')
      .steps.map((s) => s.run ?? '')
      .join('\n');
    const written = [...run.matchAll(/echo "(SDLC_IMAGE[A-Z0-9_]*)=/g)].map((m) => m[1]);
    const lock = [...parseEnvFile(readDeployFile('images.lock.env')).keys()];
    expect(written).toEqual(lock);
  });
});

describe('V04: Compose uses the published images on a release checkout only', () => {
  const lock = parseEnvFile(readDeployFile('images.lock.env'));

  it('the lock file is empty, or complete and pinned by digest, never ahead of package.json', () => {
    expect([...lock.keys()]).toEqual([
      'SDLC_IMAGES_VERSION',
      ...Object.keys(LOCK_NAMES).map((n) => `SDLC_IMAGE_${n}`),
    ]);
    const values = [...lock.values()];
    if (values.every((v) => v === '')) return;
    const version = lock.get('SDLC_IMAGES_VERSION')!;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const num = (v: string) => v.split('.').map(Number);
    const [a, b] = [num(version), num(pkgVersion)];
    const cmp = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
    expect(cmp).toBeLessThanOrEqual(0);
    for (const [name, image] of Object.entries(LOCK_NAMES))
      expect(lock.get(`SDLC_IMAGE_${name}`)).toMatch(
        new RegExp(`^${PREFIX.replace(/\./g, '\\.')}/${image}@sha256:[0-9a-f]{64}$`),
      );
  });

  it('the overlay covers every service Compose builds, removes its build and names its lock entry', () => {
    const text = readDeployFile('docker-compose.images.yml');
    const overlay = parse(text, { customTags: [{ tag: '!reset', resolve: () => null }] }) as {
      services: Record<string, { image?: string; build?: unknown; pull_policy?: string }>;
    };
    const built = Object.entries(loadCompose().services)
      .filter(([, s]) => (s as { build?: unknown }).build)
      .map(([name]) => name)
      .sort();
    expect(Object.keys(overlay.services).sort()).toEqual(built);
    expect(text.match(/^ {4}build: !reset null$/gm)?.length).toBe(built.length);
    for (const s of Object.values(overlay.services)) {
      expect(s.build).toBeNull();
      expect(s.image).toMatch(/^\$\{SDLC_IMAGE_[A-Z_]+:\?/);
      expect(s.pull_policy).toBe('missing');
    }
    for (const n of ['API', 'WORKER', 'RUNNER', 'OTEL_COLLECTOR'])
      expect(text).toContain(`\${SDLC_IMAGE_${n}:?`);
  });

  it('up.sh adds the overlay only in the published mode, with the lock entries', () => {
    const up = readDeployFile('scripts/up.sh');
    expect(up).toContain('scripts/images.sh" mode');
    expect(up).toContain('scripts/images.sh" export');
    expect(up).toContain('-f "$deploy_dir/docker-compose.images.yml"');
    const trial = read('platform/deploy/trial/src/up.ts');
    expect(trial).toContain("['get', 'SANDBOX_NODE24']");
  });
});

describe('V04: scripts/images.sh', () => {
  const temp: string[] = [];
  afterAll(() => {
    for (const dir of temp) fs.rmSync(dir, { recursive: true, force: true });
  });

  const digest = (c: string) => `sha256:${c.repeat(64)}`;
  const completeLock = (version: string, prefix = PREFIX) =>
    [
      `SDLC_IMAGES_VERSION=${version}`,
      ...Object.entries(LOCK_NAMES).map(
        ([n, image], i) => `SDLC_IMAGE_${n}=${prefix}/${image}@${digest('abcde'[i]!)}`,
      ),
    ].join('\n') + '\n';

  /** A throw-away tree with the script, a lock file and a package.json; Git when asked. */
  function tree(opts: { lock: string; pkg: string; git?: 'tagged' | 'untagged' | 'dirty' }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-images-'));
    temp.push(dir);
    fs.mkdirSync(path.join(dir, 'platform/deploy/scripts'), { recursive: true });
    fs.copyFileSync(
      path.join(root, 'platform/deploy/scripts/images.sh'),
      path.join(dir, 'platform/deploy/scripts/images.sh'),
    );
    fs.writeFileSync(path.join(dir, 'platform/deploy/images.lock.env'), opts.lock);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `{\n  "name": "x",\n  "version": "${opts.pkg}"\n}\n`,
    );
    if (opts.git) {
      const git = (...args: string[]) => {
        const r = spawnSync('git', ['-C', dir, ...args], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@example.invalid',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@example.invalid',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          },
        });
        expect(r.status, r.stderr).toBe(0);
      };
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'release');
      if (opts.git !== 'untagged') git('tag', `v${opts.pkg}`);
      if (opts.git === 'dirty') fs.appendFileSync(path.join(dir, 'package.json'), '\n');
    }
    return dir;
  }

  function images(dir: string, args: string[], env: Record<string, string> = {}) {
    const r = spawnSync('sh', [path.join(dir, 'platform/deploy/scripts/images.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
    return { status: r.status, out: r.stdout.trim(), err: r.stderr };
  }

  it('the committed lock file gives `local` in this checkout (not a release tag)', () => {
    const r = spawnSync('sh', [path.join(root, 'platform/deploy/scripts/images.sh'), 'mode'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(r.status).toBe(0);
    expect(['local', 'published']).toContain(r.stdout.trim());
  });

  it('published on the release tag with no change; local otherwise', () => {
    const lock = completeLock('0.2.0');
    expect(images(tree({ lock, pkg: '0.2.0', git: 'tagged' }), ['mode']).out).toBe('published');
    expect(images(tree({ lock, pkg: '0.2.0', git: 'untagged' }), ['mode']).out).toBe('local');
    expect(images(tree({ lock, pkg: '0.2.0', git: 'dirty' }), ['mode']).out).toBe('local');
    // A tag of another version (main after the next version bump) is not a release checkout.
    expect(images(tree({ lock, pkg: '0.3.0', git: 'tagged' }), ['mode']).out).toBe('local');
  });

  it('a source archive (no .git) is a release checkout when package.json has the lock version', () => {
    const lock = completeLock('0.2.0');
    expect(images(tree({ lock, pkg: '0.2.0' }), ['mode']).out).toBe('published');
    expect(images(tree({ lock, pkg: '0.2.1' }), ['mode']).out).toBe('local');
  });

  it('an empty or foreign lock file is never used', () => {
    const empty = readDeployFile('images.lock.env').replace(/=.*$/gm, '=');
    expect(images(tree({ lock: empty, pkg: '0.2.0' }), ['mode']).out).toBe('local');
    const foreign = completeLock('0.2.0', 'ghcr.io/someone-else/fork');
    expect(images(tree({ lock: foreign, pkg: '0.2.0', git: 'tagged' }), ['mode']).out).toBe(
      'local',
    );
    const r = images(tree({ lock: empty, pkg: '0.2.0' }), ['get', 'API']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('not complete');
  });

  it('SDLC_IMAGES overrides the choice; published needs a complete lock file', () => {
    const lock = completeLock('0.2.0');
    const untagged = tree({ lock, pkg: '0.2.0', git: 'untagged' });
    expect(images(untagged, ['mode'], { SDLC_IMAGES: 'published' }).out).toBe('published');
    const tagged = tree({ lock, pkg: '0.2.0', git: 'tagged' });
    expect(images(tagged, ['mode'], { SDLC_IMAGES: 'local' }).out).toBe('local');
    const empty = tree({ lock: 'SDLC_IMAGES_VERSION=\n', pkg: '0.2.0' });
    expect(images(empty, ['mode'], { SDLC_IMAGES: 'published' }).status).toBe(1);
    expect(images(tagged, ['mode'], { SDLC_IMAGES: 'yes' }).status).toBe(1);
  });

  it('get and export print the pinned references; an unknown name is refused', () => {
    const dir = tree({ lock: completeLock('0.2.0'), pkg: '0.2.0' });
    expect(images(dir, ['get', 'SANDBOX_NODE24']).out).toBe(
      `${PREFIX}/sandbox-node24@${digest('e')}`,
    );
    expect(images(dir, ['get', 'POSTGRES']).status).toBe(1);
    expect(images(dir, ['export']).out.split('\n')).toEqual(
      completeLock('0.2.0').trim().split('\n'),
    );
    expect(images(dir, []).status).toBe(2);
  });
});

describe('V04: the README says how to verify the published images', () => {
  const start = readme.indexOf('## Verify the published images');
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1));

  it('has the section, with the identity and issuer the workflow signs with', () => {
    expect(start).toBeGreaterThan(0);
    expect(section).toContain('cosign verify');
    expect(section).toContain(
      "--certificate-identity-regexp '^https://github\\.com/hoanghainh1188/agentic-sdlc-framework/\\.github/workflows/release-images\\.yml@'",
    );
    expect(section).toContain(
      '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
    );
    expect(section).toContain('gh attestation verify');
    expect(section).toContain('--repo hoanghainh1188/agentic-sdlc-framework');
  });
});
