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
  'timeout-minutes'?: number;
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
  it('runs on every pull request, daily, weekly and on demand; not again on a push to main', () => {
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    // Every branch, no path filter; ready_for_review starts the heavy jobs a draft skipped.
    expect(ci.on.pull_request).toEqual({
      types: ['opened', 'synchronize', 'reopened', 'ready_for_review'],
    });
    const crons = (ci.on.schedule as { cron: string }[]).map((s) => s.cron);
    expect(crons).toEqual([ciEnv.DAILY_CRON, ciEnv.WEEKLY_CRON]);
    expect(ciEnv.DAILY_CRON).toBe('0 18 * * 1-6');
    expect(ciEnv.WEEKLY_CRON).toBe('0 18 * * 0'); // never on the same day as the daily run
  });

  it('checks runs on every pull request; only a daily run on an unchanged main skips it', () => {
    const condition = "${{ !cancelled() && needs.scan.outputs.run_checks != 'false' }}";
    expect(job('checks').needs).toBe('scan');
    expect(job('checks').if).toBe(condition);
    const scan = runText('scan');
    expect(scan).toContain('checks=true;');
    // The only line that sets run_checks to false is guarded by the daily run.
    const falseLines = scan.split('\n').filter((line) => line.includes('checks=false'));
    expect(falseLines).toHaveLength(1);
    expect(scan).toMatch(
      /if \[ "\$daily" = true \] && \[ -z "\$\(git log -1 --since='25 hours ago'[^\n]*\n\s*checks=false;/,
    );
    expect(scan).toMatch(/elif \[ "\$EVENT_NAME" = schedule \]; then\s*daily=true/);
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

  // Every change to main goes through a reviewed pull request (CLAUDE.md "Current constraints"),
  // and no workflow commits to a pull request branch either: a commit pushed by a workflow waits
  // for approval and leaves the PR head without ci-ok (the render-diagrams bot, removed).
  it.each(workflows)('$file never writes contents and never pushes', ({ wf }) => {
    const grants = [wf.permissions, ...Object.values(wf.jobs).map((job) => job.permissions)];
    for (const grant of grants) {
      if (grant && typeof grant === 'object') {
        expect((grant as Record<string, string>).contents).not.toBe('write');
      } else if (grant !== undefined) {
        expect(grant).not.toBe('write-all');
      }
    }
    const runsGitPush = Object.values(wf.jobs).some((job) =>
      job.steps.some((step) => step.run?.includes('git push')),
    );
    expect(runsGitPush).toBe(false);
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

  it.each(workflows)('$file sets timeout-minutes on every job', ({ wf }) => {
    for (const job of Object.values(wf.jobs)) {
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      expect(job['timeout-minutes']).toBeLessThanOrEqual(40);
    }
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

describe('diagrams: CI checks the committed SVG, it never renders or commits', () => {
  it('the scan job runs the diagram check on every run', () => {
    const step = job('scan').steps.find((s) => s.run === 'python3 scripts/diagrams.py check');
    expect(step?.if).toBe('${{ !cancelled() }}');
    expect(workflowFiles).not.toContain('.github/workflows/render-diagrams.yml');
  });

  it('pnpm diagrams:render uses mermaid-cli pinned by version and digest, offline', () => {
    const script = fs.readFileSync(path.join(root, 'scripts/diagrams.py'), 'utf8');
    expect(script).toMatch(/"minlag\/mermaid-cli:\d+\.\d+\.\d+"\s*"@sha256:[0-9a-f]{64}"/);
    expect(script).toContain('"--network", "none"');
  });
});

describe('AC2: integration job runs the Compose core profile', () => {
  it('the scan job decides; compose shows as skipped (not passed) until the Compose file exists', () => {
    expect(job('scan').outputs?.run_compose).toBeDefined();
    expect(job('scan').outputs?.run_sandbox_image).toBeDefined();
    // Heavy jobs start only after scan and checks passed (no status function in their if).
    for (const heavy of ['compose', 'sandbox-image'])
      expect(job(heavy).needs).toEqual(['scan', 'checks']);
    expect(job('compose').if).toBe("needs.scan.outputs.run_compose == 'true'");
    expect(job('sandbox-image').if).toBe("needs.scan.outputs.run_sandbox_image == 'true'");
    expect(ciEnv.COMPOSE_FILE_PATH).toBe('platform/deploy/docker-compose.yml');
    const scan = runText('scan');
    expect(scan).toContain('[ ! -f "$COMPOSE_FILE_PATH" ]');
    expect(scan).toContain(
      'platform/deploy/ platform/packages/secrets/ platform/tests/integration/openbao/ platform/packages/adapters/model-litellm/ platform/packages/core/src/cost/ platform/tests/integration/litellm/',
    );
    expect(scan).toContain('git diff --name-only "$BASE_SHA" "$HEAD_SHA" -- "$@"');
  });

  it('C09: the sandbox image job runs the pilot suite, also when the gate steps or the worker change', () => {
    const steps = job('sandbox-image').steps.map((s) => s.run ?? '');
    expect(steps.indexOf('pnpm test:pilot')).toBeGreaterThan(steps.indexOf('pnpm test:agent'));
    const scan = runText('scan');
    const paths = scan.slice(scan.indexOf('decide_heavy run_sandbox_image')).split('\n\n')[0]!;
    for (const p of [
      'platform/packages/core/src/workflow/',
      'platform/apps/worker/',
      'platform/tests/integration/pilot/',
    ])
      expect(paths.split(/\s+/)).toContain(p);
  });

  it('E07: the fresh deployment job runs on the weekly schedule and on demand only, and cleans up', () => {
    expect(job('scan').outputs?.run_fresh_deploy).toBeDefined();
    expect(runText('scan')).toContain('echo "run_fresh_deploy=$all" >> "$GITHUB_OUTPUT"');
    expect(job('fresh-deploy').needs).toEqual(['scan', 'checks']);
    expect(job('fresh-deploy').if).toBe("needs.scan.outputs.run_fresh_deploy == 'true'");
    const steps = job('fresh-deploy').steps;
    expect(steps.map((s) => s.run ?? '')).toContain('pnpm test:fresh-deploy');
    expect(steps.at(-1)).toMatchObject({ if: 'always()' });
    expect(job('ci-ok').needs).toContain('fresh-deploy');
  });

  it('heavy jobs run on the weekly schedule and on demand, never on the daily run or a draft (ADR-M25 §2.9)', () => {
    const scan = runText('scan');
    expect(scan).toMatch(/workflow_dispatch \]; then\s*all=true/);
    expect(scan).toMatch(/\[ "\$SCHEDULE" = "\$WEEKLY_CRON" \]; then\s*all=true/);
    expect(scan).toMatch(/elif \[ "\$all" = true \]; then\s*run=true/);
    expect(scan).toMatch(/elif \[ "\$daily" = true \]; then\s*why=/);
    expect(scan).toMatch(/elif \[ "\$DRAFT" = true \]; then\s*why=/);
    expect(scan).toContain('base commit unknown, running to be safe');
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
  it('runs the DB tests on every PR (same condition as checks), and ci-ok waits for it', () => {
    expect(job('db').needs).toBe('scan');
    expect(job('db').if).toBe(job('checks').if);
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
    expect(runText('scan')).not.toMatch(/--severity[ =]["']?(CRITICAL|HIGH|ERROR)/);
  });

  it('one scan job runs every scanner, even when an earlier one failed', () => {
    const scanners = job('scan').steps.filter((s) => s.run && s.name);
    expect(scanners.length).toBeGreaterThanOrEqual(6);
    for (const step of scanners) expect(step.if).toBe('${{ !cancelled() }}');
  });

  it('gitleaks scans the full history of the checked-out commit and fails on any finding', () => {
    const checkout = job('scan').steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(runText('scan')).toMatch(/gitleaks" git --config \.gitleaks\.toml .*--exit-code 1/s);
    expect(runText('scan')).toContain('--log-opts HEAD'); // not --all: other branches are not this PR
  });

  it('semgrep fails on findings at the blocking severity', () => {
    expect(runText('scan')).toMatch(/--severity "\$SEMGREP_BLOCK_SEVERITY" --error/);
  });

  it('trivy reports HIGH without blocking, and fails on CRITICAL (dev dependencies included)', () => {
    const [report, block] = runs('scan').filter((r) => r.includes('trivy" fs'));
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
    // Always on pull requests and manual runs; scheduled runs have no summary job.
    expect(job('ci-ok').if).toBe("${{ always() && github.event_name != 'schedule' }}");
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
