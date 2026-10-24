// H04 (ADR-M93 §2.1): one Gitleaks pin. The runner's secret scan uses the version and SHA-256 of
// `platform/deploy/scripts/gitleaks.sh`; they equal the CI `scan` job's; the runner image and every
// CI job that runs the runner in-process get Gitleaks from that script.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const script = read('platform/deploy/scripts/gitleaks.sh');
const ci = parse(read('.github/workflows/ci.yml')) as {
  env: Record<string, string>;
  jobs: Record<string, { steps: { run?: string }[] }>;
};

describe('H04: the Gitleaks pin of the runner', () => {
  it('the script pins the same version and linux x64 SHA-256 as the CI scan job', () => {
    expect(/^VERSION=(\S+)$/m.exec(script)?.[1]).toBe(ci.env.GITLEAKS_VERSION);
    expect(/Linux\/x86_64\) asset=linux_x64; sha=([0-9a-f]{64})/.exec(script)?.[1]).toBe(
      ci.env.GITLEAKS_SHA256,
    );
    // Four platforms, each with its own SHA-256 check.
    expect(script.match(/sha=[0-9a-f]{64}/g)).toHaveLength(4);
    expect(script).toContain('SHA-256 mismatch');
  });

  it('the runner image installs Gitleaks from the script', () => {
    const dockerfile = read('platform/apps/runner/Dockerfile');
    expect(dockerfile).toContain('COPY platform/deploy/scripts/gitleaks.sh');
    expect(dockerfile).toContain('/usr/local/bin/gitleaks');
    expect(read('platform/apps/runner/Dockerfile.dockerignore')).toContain(
      '!platform/deploy/scripts/gitleaks.sh',
    );
  });

  it.each(['checks', 'compose', 'runner-rootless', 'sandbox-image'])(
    "CI job %s puts the script's Gitleaks on PATH and in SDLC_RUNNER_GITLEAKS_PATH",
    (job) => {
      const runs = ci.jobs[job]!.steps.map((s) => s.run ?? '').join('\n');
      expect(runs).toContain('gitleaks="$(sh platform/deploy/scripts/gitleaks.sh)"');
      expect(runs).toContain('dirname "$gitleaks" >> "$GITHUB_PATH"');
      expect(runs).toContain('SDLC_RUNNER_GITLEAKS_PATH=$gitleaks');
    },
  );
});
