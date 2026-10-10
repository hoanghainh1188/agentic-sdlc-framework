// The npm package `agentic-sdlc-cli` (task V05, design/ADR-M72): static checks of its template,
// its build and check scripts, the CI step and the tag-only publish workflow. The package itself
// is built, packed, installed and run by `pnpm cli:pack-check` (CI job `checks`).
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'working-directory'?: string;
}
interface Job {
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const template = JSON.parse(read('platform/apps/cli/npm/package.template.json')) as Record<
  string,
  unknown
>;
const publish = parse(read('.github/workflows/npm-publish.yml')) as Workflow;
const publishText = read('.github/workflows/npm-publish.yml');

describe('package template', () => {
  it('names the package and its one command', () => {
    expect(template.name).toBe('agentic-sdlc-cli');
    expect(template.bin).toEqual({ sdlc: 'bin/sdlc.cjs' });
    expect(template.license).toBe('MIT');
    expect(template.engines).toEqual({ node: '>=24 <25' });
  });

  it('has no dependencies: everything is bundled', () => {
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'scripts']) {
      expect(template[key]).toBeUndefined();
    }
  });

  it('allows only the bundle, the shipped defaults and the notices (npm adds the rest)', () => {
    expect(template.files).toEqual([
      'bin/sdlc.cjs',
      'defaults/project-config.default.yaml',
      'THIRD-PARTY-NOTICES',
    ]);
  });

  it('publishes publicly with provenance', () => {
    expect(template.publishConfig).toEqual({ access: 'public', provenance: true });
  });

  it('is never a workspace package (pnpm-workspace.yaml globs one level under apps/)', () => {
    expect(fs.existsSync(path.join(root, 'platform/apps/cli/npm/package.json'))).toBe(false);
  });
});

describe('build and check scripts', () => {
  const build = read('platform/tools/cli-package/build.mjs');
  const check = read('platform/tools/cli-package/check.mjs');

  it('bundle without source maps and refuse a version mismatch and unknown licences', () => {
    expect(build).toContain('sourcemap: false');
    expect(build).toContain('version mismatch');
    expect(build).toContain('ALLOWED_LICENCES');
  });

  it('the check packs, scans and installs into an empty folder, and never publishes', () => {
    expect(check).toContain("'--dry-run'");
    expect(check).toContain("'install', '-g', '--prefix'");
    expect(check).toContain("['--version']");
    expect(check).not.toMatch(/['"]publish['"]/);
  });

  it('pnpm cli:pack-check builds then checks', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts['cli:pack']).toBe(
      'tsc -b platform/apps/cli && node platform/tools/cli-package/build.mjs',
    );
    expect(pkg.scripts['cli:pack-check']).toBe(
      'pnpm cli:pack && node platform/tools/cli-package/check.mjs',
    );
    expect(pkg.devDependencies.rolldown).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the build output is never committed', () => {
    expect(read('.gitignore')).toContain('platform/apps/cli/npm-dist/');
  });
});

describe('CI runs the check on every pull request', () => {
  it('the checks job runs pnpm cli:pack-check', () => {
    const ci = parse(read('.github/workflows/ci.yml')) as Workflow;
    const runs = ci.jobs.checks?.steps.map((step) => step.run) ?? [];
    expect(runs).toContain('pnpm cli:pack-check');
  });
});

describe('npm-publish workflow', () => {
  const job = publish.jobs.publish;

  it('runs only for a release tag', () => {
    expect(publish.on).toEqual({ push: { tags: ['v*'] } });
  });

  it('waits for the environment npm and asks only for an OIDC token', () => {
    expect(publish.permissions).toEqual({ contents: 'read' });
    expect(job?.environment).toBe('npm');
    expect(job?.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('uses no npm token or secret (trusted publishing)', () => {
    expect(publishText).not.toMatch(/secrets\./);
    expect(publishText).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/);
    const setupNode = job?.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with?.['registry-url']).toBeUndefined();
  });

  it('checks the tag against the version, checks the package, then publishes with provenance', () => {
    const runs = job?.steps.flatMap((step) => (step.run ? [step.run] : [])) ?? [];
    // V12: the release gate shared with release.yml (tag, package.json, PLATFORM_VERSION, ...).
    const tagCheck = runs.findIndex((r) =>
      r.includes('node platform/tools/release/release-check.mjs tag "$TAG"'),
    );
    const packCheck = runs.findIndex((r) => r.includes('pnpm cli:pack-check'));
    const publishStep = runs.findIndex((r) => r.startsWith('npm publish'));
    expect(tagCheck).toBeGreaterThanOrEqual(0);
    expect(packCheck).toBeGreaterThan(tagCheck);
    expect(publishStep).toBeGreaterThan(packCheck);
    expect(runs[publishStep]).toBe('npm publish --provenance --access public');
    const step = job?.steps.find((s) => s.run === runs[publishStep]);
    expect(step?.['working-directory']).toBe('platform/apps/cli/npm-dist');
  });

  it('reads the tag through an environment variable, never inline in a script', () => {
    const runs = job?.steps.flatMap((step) => (step.run ? [step.run] : [])) ?? [];
    for (const run of runs) expect(run).not.toContain('${{');
  });
});
