// D-08 A09: CI for the platform repo. Static checks of the workflow files; the fault-injection
// runs (a failing check, a fake secret, a critical dependency) are linked in the A09 pull request.
import fs from 'node:fs';
import path from 'node:path';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { repoRoot } from './helpers';

const root = repoRoot();
const workflowsDir = path.join(root, '.github/workflows');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: unknown;
  outputs?: Record<string, string>;
  steps: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

function readYaml<T>(file: string): T {
  return parse(fs.readFileSync(path.join(root, file), 'utf8')) as T;
}

const workflowFiles = fs
  .readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => `.github/workflows/${name}`);
const workflows = workflowFiles.map((file) => ({ file, wf: readYaml<Workflow>(file) }));
const ci = readYaml<Workflow>('.github/workflows/ci.yml');
const ciEnv = ci.env ?? {};

function job(name: string): Job {
  const found = ci.jobs[name];
  if (!found) throw new Error(`ci.yml has no job "${name}"`);
  return found;
}

function runs(name: string): string[] {
  return job(name).steps.flatMap((step) => (step.run ? [step.run] : []));
}

function runText(name: string): string {
  return runs(name).join('\n');
}

describe('AC1: lint, type check and unit tests run on every PR', () => {
  it('runs on pull requests, on pushes to main and nightly', () => {
    expect(Object.keys(ci.on)).toEqual(
      expect.arrayContaining(['pull_request', 'push', 'schedule', 'workflow_dispatch']),
    );
    expect(ci.on.pull_request ?? null).toBeNull(); // every branch, no path filter
  });

  it('the checks job installs from the lockfile and runs every repo check', () => {
    expect(runs('checks')).toEqual(
      expect.arrayContaining([
        'pnpm install --frozen-lockfile',
        'pnpm build',
        'pnpm typecheck',
        'pnpm lint',
        'pnpm format:check',
        'pnpm test',
      ]),
    );
    expect(runText('checks')).toContain('actionlint');
  });
});

describe('workflow hardening (all workflows)', () => {
  it.each(workflows)('$file pins every action by commit SHA', ({ wf }) => {
    const uses = Object.values(wf.jobs).flatMap((job) =>
      job.steps.flatMap((step) => (step.uses ? [step.uses] : [])),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it.each(workflows)(
    '$file declares top-level permissions and never uses pull_request_target',
    ({ wf }) => {
      expect(wf.permissions).toBeDefined();
      expect(Object.keys(wf.on)).not.toContain('pull_request_target');
    },
  );

  // Every change to main goes through a reviewed pull request (CLAUDE.md "Current constraints").
  it.each(workflows)('$file has no push trigger when it can write contents', ({ wf }) => {
    if (wf.permissions?.contents === 'write') {
      expect(Object.keys(wf.on)).not.toContain('push');
    }
  });

  it.each(workflows)('$file only pushes to a pull request branch, never to main', ({ wf }) => {
    const pushScripts = Object.values(wf.jobs).flatMap((job) =>
      job.steps.flatMap((step) => (step.run?.includes('git push') ? [step.run] : [])),
    );
    for (const script of pushScripts) {
      expect(script).toContain('git push origin "HEAD:refs/heads/${HEAD_REF}"');
      expect(script).toContain('[ "$HEAD_REF" = "main" ]');
    }
  });

  it.each(workflows)('$file pins the version of every global npm install', ({ wf }) => {
    const installs = Object.values(wf.jobs).flatMap((job) =>
      job.steps.flatMap((step) =>
        (step.run ?? '').split('\n').filter((line) => /npm (install|i) -g/.test(line)),
      ),
    );
    for (const line of installs) expect(line).toMatch(/@[\w/-]+@(\$\{\w+\}|\d+\.\d+\.\d+)/);
  });

  it('ci.yml only reads the repository and no job widens permissions', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(ci.jobs)) expect(job.permissions).toBeUndefined();
  });

  it('ci.yml checkouts do not keep the token on disk', () => {
    for (const job of Object.values(ci.jobs)) {
      for (const step of job.steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
        expect(step.with?.['persist-credentials']).toBe(false);
      }
    }
  });

  it('downloaded tools are checked against a pinned SHA-256', () => {
    for (const tool of ['GITLEAKS', 'TRIVY', 'ACTIONLINT']) {
      expect(ciEnv[`${tool}_SHA256`]).toMatch(/^[0-9a-f]{64}$/);
    }
    const all = Object.keys(ci.jobs).map(runText).join('\n');
    expect(all.match(/curl -fsSLo/g)?.length).toBe(all.match(/sha256sum -c -/g)?.length);
    expect(ciEnv.SEMGREP_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('Prettier formats the workflow files (ADR-M16 section 2.6, revisited in A09)', async () => {
    for (const file of workflowFiles) {
      const info = await prettier.getFileInfo(path.join(root, file), {
        ignorePath: path.join(root, '.prettierignore'),
      });
      expect(info.ignored).toBe(false);
    }
  });
});

describe('AC2: integration job runs the Compose core profile', () => {
  it('a detect job decides; compose shows as skipped (not passed) until the Compose file exists', () => {
    expect(job('detect').outputs?.run_compose).toBeDefined();
    expect(job('compose').needs).toBe('detect');
    expect(job('compose').if).toBe("needs.detect.outputs.run_compose == 'true'");
    expect(ciEnv.COMPOSE_FILE_PATH).toBe('platform/deploy/docker-compose.yml');
    const detect = runText('detect');
    expect(detect).toContain('[ ! -f "$COMPOSE_FILE_PATH" ]');
    expect(detect).toContain(
      '-- platform/deploy/ platform/packages/secrets/ platform/tests/integration/openbao/ platform/packages/adapters/model-litellm/ platform/packages/core/src/cost/ platform/tests/integration/litellm/',
    );
    expect(detect).toContain('schedule');
  });

  it('starts the core profile with the A02 scripts, runs integration tests and always cleans up', () => {
    const compose = runText('compose');
    expect(compose).toContain('platform/deploy/scripts/init-env.sh');
    expect(compose).toContain('platform/deploy/scripts/up.sh core');
    expect(compose).toContain('pnpm test:integration');
    expect(compose).toContain('pnpm test:litellm');
    expect(compose).toContain('pnpm test:runner');
    const cleanup = job('compose').steps.find((s) => s.run?.includes('down --volumes'));
    expect(cleanup?.if).toBe('always()');
  });
});

describe('A06: database integration job', () => {
  it('runs the DB tests on every PR, without a skip condition, and ci-ok waits for it', () => {
    expect(job('db').if).toBeUndefined();
    expect(runText('db')).toContain('pnpm test:db');
    expect(job('ci-ok').needs).toContain('db');
  });

  it('B07: runs the intent workflow tests on the pinned Temporal test server', () => {
    expect(runText('db')).toContain('pnpm test:workflow');
  });

  it('pnpm test:db uses a throw-away container and requires a database', () => {
    const script = fs.readFileSync(path.join(root, 'platform/deploy/scripts/test-db.sh'), 'utf8');
    expect(script).toContain('SDLC_REQUIRE_DB=1');
    expect(script).toContain('-p 127.0.0.1::5432');
    expect(script).toContain('postgres/init:/docker-entrypoint-initdb.d:ro');
    expect(script).toMatch(/trap cleanup EXIT/);
  });
});

describe('AC3: Gitleaks, Semgrep and Trivy run and block critical findings', () => {
  it('thresholds are set once, in the workflow env', () => {
    expect(ciEnv.TRIVY_BLOCK_SEVERITY).toBe('CRITICAL');
    expect(ciEnv.TRIVY_REPORT_SEVERITY).toBe('HIGH');
    expect(ciEnv.SEMGREP_BLOCK_SEVERITY).toBe('ERROR');
    expect(ciEnv.SEMGREP_RULESETS).toBe('p/default p/github-actions');
    for (const job of ['gitleaks', 'semgrep', 'trivy']) {
      expect(runText(job)).not.toMatch(/--severity[ =]["']?(CRITICAL|HIGH|ERROR)/);
    }
  });

  it('gitleaks scans the full history of the checked-out commit and fails on any finding', () => {
    const checkout = job('gitleaks').steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(runText('gitleaks')).toMatch(/gitleaks" git --config \.gitleaks\.toml .*--exit-code 1/s);
    expect(runText('gitleaks')).toContain('--log-opts HEAD'); // not --all: other branches are not this PR
  });

  it('semgrep fails on findings at the blocking severity', () => {
    expect(runText('semgrep')).toMatch(/--severity "\$SEMGREP_BLOCK_SEVERITY" --error/);
  });

  it('trivy reports HIGH without blocking, and fails on CRITICAL (dev dependencies included)', () => {
    const [report, block] = runs('trivy').filter((r) => r.includes('trivy" fs'));
    expect(report).toContain('--exit-code 0');
    expect(report).toContain('$TRIVY_REPORT_SEVERITY');
    expect(report).toContain('$GITHUB_STEP_SUMMARY');
    expect(block).toContain('--severity "$TRIVY_BLOCK_SEVERITY"');
    expect(block).toContain('--exit-code 1');
    for (const r of [report, block]) expect(r).toContain('--include-dev-deps');
  });

  it('ci-ok fails when any job failed or was cancelled, and treats skipped as OK', () => {
    const others = Object.keys(ci.jobs).filter((name) => name !== 'ci-ok');
    expect(job('ci-ok').needs).toEqual(others);
    expect(job('ci-ok').if).toBe('always()');
    expect(runText('ci-ok')).toContain('success | skipped) ;;');
  });

  it('exception files exist and extend (not replace) the gitleaks default rules', () => {
    for (const file of ['.gitleaks.toml', '.trivyignore', '.semgrepignore']) {
      expect(fs.existsSync(path.join(root, file))).toBe(true);
    }
    expect(fs.readFileSync(path.join(root, '.gitleaks.toml'), 'utf8')).toMatch(
      /\[extend\]\s*useDefault = true/,
    );
  });
});

describe('Dependabot and CODEOWNERS', () => {
  it('Dependabot updates GitHub Actions and Compose images weekly', () => {
    const config = readYaml<{
      updates: { 'package-ecosystem': string; schedule: { interval: string } }[];
    }>('.github/dependabot.yml');
    expect(config.updates.map((u) => u['package-ecosystem']).sort()).toEqual([
      'docker-compose',
      'github-actions',
    ]);
    for (const update of config.updates) expect(update.schedule.interval).toBe('weekly');
  });

  it('Dependabot never proposes major image updates, keeps ClickHouse on its LTS line and groups Temporal', () => {
    type Ignore = { 'dependency-name': string; 'update-types'?: string[] };
    const config = readYaml<{
      updates: {
        'package-ecosystem': string;
        ignore?: Ignore[];
        groups?: Record<string, { patterns: string[] }>;
      }[];
    }>('.github/dependabot.yml');
    const compose = config.updates.find((u) => u['package-ecosystem'] === 'docker-compose');
    const ignores = compose?.ignore ?? [];
    const ignored = (name: string, type: string): boolean =>
      ignores.some(
        (i) => i['dependency-name'] === name && (i['update-types'] ?? []).includes(type),
      );
    expect(ignored('*', 'version-update:semver-major')).toBe(true);
    expect(ignored('clickhouse/clickhouse-server', 'version-update:semver-minor')).toBe(true);
    const patterns = Object.values(compose?.groups ?? {}).flatMap((g) => g.patterns);
    expect(patterns).toContain('temporalio/*');
  });

  it('CODEOWNERS has a default owner and names only known owners', () => {
    const rules = fs
      .readFileSync(path.join(root, '.github/CODEOWNERS'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/\s+/));
    expect(rules[0]).toEqual(['*', '@hoanghainh1188']);
    for (const [, ...owners] of rules) expect(owners).toEqual(['@hoanghainh1188']);
  });
});
