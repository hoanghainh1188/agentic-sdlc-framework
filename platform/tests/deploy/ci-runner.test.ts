// ADR-M34: static checks of the self-hosted CI runner set-up (no VM, no Docker needed).
// - The runner and Docker come from pinned, checked sources.
// - The runner is registered on this repository only, with the label ci.yml uses.
// - Tokens are read from hidden input, never from the command line of setup.sh or a file.
// - The hooks clean Docker before and after every job; the runner user never gets sudo.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { readDeployFile, root } from './compose';

const setup = readDeployFile('ci-runner/setup.sh');
const clean = readDeployFile('ci-runner/clean-docker.sh');
const started = readDeployFile('ci-runner/job-started.sh');
const completed = readDeployFile('ci-runner/job-completed.sh');
const runbook = readDeployFile('ci-runner/README.md');

function variable(name: string): string {
  const match = new RegExp(`^${name}=(\\S+)$`, 'm').exec(setup);
  if (!match?.[1]) throw new Error(`setup.sh has no ${name}`);
  return match[1];
}

describe('ADR-M34: runner installation', () => {
  it('downloads a pinned runner release and checks its SHA-256 before extracting it', () => {
    expect(variable('RUNNER_VERSION')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(variable('RUNNER_SHA256')).toMatch(/^[0-9a-f]{64}$/);
    const check = setup.indexOf('echo "$RUNNER_SHA256  $tmp/$archive" | sha256sum -c -');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(setup.indexOf('tar -xzf "$tmp/$archive"'));
    expect(setup).toContain('set -euo pipefail');
  });

  it("installs Docker only after checking the fingerprint of Docker's apt signing key", () => {
    expect(variable('DOCKER_KEY_FINGERPRINT')).toBe('9DC858229FC7DD38854AE2D88D81803C0EBFCD88');
    expect(setup).toContain('[ "$fpr" = "$DOCKER_KEY_FINGERPRINT" ] || die');
    expect(setup).toContain('signed-by=/etc/apt/keyrings/docker.asc');
    for (const pkg of ['docker-buildx-plugin', 'docker-compose-plugin', 'jq', 'openssl', 'zstd']) {
      expect(setup).toContain(pkg);
    }
  });

  it('the runner user is in the docker group and never gets a sudo rule', () => {
    expect(variable('RUNNER_USER')).toBe('ghrunner');
    expect(setup).toContain('usermod -aG docker "$RUNNER_USER"');
    expect(setup).not.toMatch(/sudoers|usermod -aG (sudo|wheel|admin)/);
  });
});

describe('ADR-M34: registration', () => {
  it('registers on this repository only, never on the organization', () => {
    expect(variable('REPO_URL')).toBe('https://github.com/harryforge/agentic-sdlc-framework');
    expect(setup).toContain('--url "$REPO_URL"');
  });

  it('uses the label that ci.yml expects in CI_RUNNER', () => {
    const label = variable('RUNNER_LABEL');
    expect(label).toBe('sdlc-ci');
    expect(setup).toContain('--labels "$RUNNER_LABEL"');
    expect(runbook).toContain(`gh variable set CI_RUNNER --body ${label}`);
    const ci = parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { 'runs-on': string }>;
    };
    for (const job of Object.values(ci.jobs)) expect(job['runs-on']).toContain('vars.CI_RUNNER');
  });

  it('reads tokens from hidden input and never takes one as an argument of setup.sh', () => {
    expect(setup).toContain('IFS= read -rs token');
    expect(setup).not.toMatch(/token="\$\{?[12]/);
    expect(setup).not.toMatch(/>\s*\S*token/i); // never written to a file
    // Every use is followed by unset.
    expect(setup.match(/--token "\$token"/g)?.length).toBe(setup.match(/unset token/g)?.length);
  });

  it('the runbook creates tokens in the admin terminal, never through a chat tool', () => {
    expect(runbook).toContain('never through a chat tool');
    expect(runbook).toContain('actions/runners/registration-token');
    expect(runbook).toContain('gh variable delete CI_RUNNER');
  });
});

describe('ADR-M34: clean-up between jobs', () => {
  it('both hooks are installed and set in the runner .env file', () => {
    expect(setup).toContain('ACTIONS_RUNNER_HOOK_JOB_STARTED=$LIB_DIR/job-started.sh');
    expect(setup).toContain('ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$LIB_DIR/job-completed.sh');
    for (const f of ['clean-docker.sh', 'job-started.sh', 'job-completed.sh']) {
      expect(setup).toContain(f);
      const mode = fs.statSync(path.join(root, 'platform/deploy/ci-runner', f)).mode;
      expect(mode & 0o111).not.toBe(0);
    }
  });

  it('removes every container, network and volume and gives the workspace back', () => {
    expect(clean).toContain('docker rm -f $containers');
    expect(clean).toContain('docker network prune -f');
    expect(clean).toContain('docker volume prune -af');
    expect(clean).toMatch(/busybox:[\d.]+@sha256:[0-9a-f]{64}/);
    expect(clean).toContain('--network none');
    expect(clean).toContain('chown -R "$(id -u):$(id -g)" /w');
  });

  it('the job-started hook fails the job when Docker is down; job-completed never fails it', () => {
    expect(started).toContain('set -eu');
    expect(started).toContain('docker info >/dev/null');
    expect(started).toContain('clean-docker.sh');
    expect(completed.trim().endsWith('exit 0')).toBe(true);
  });

  it('prunes images daily before the scheduled CI runs', () => {
    const timer = readDeployFile('ci-runner/sdlc-ci-prune.timer');
    const service = readDeployFile('ci-runner/sdlc-ci-prune.service');
    expect(timer).toContain('OnCalendar=*-*-* 17:00:00 UTC'); // ci.yml schedules run at 18:00 UTC
    expect(service).toContain('ExecStart=/usr/bin/docker system prune -af');
  });
});
