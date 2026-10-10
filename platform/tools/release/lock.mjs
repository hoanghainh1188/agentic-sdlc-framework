#!/usr/bin/env node
// `pnpm release:lock <run-id>` (task V12, RELEASING.md step 3): copies the images.lock of a
// release-images run over platform/deploy/images.lock, for the lock file pull request
// (ADR-M66 §2.5, QUESTIONS #370). It reads only: `gh run view` and `gh run download` of this
// repository. It refuses a run that is not a successful `release-images` run on `main`, or a
// lock file that release-check.mjs refuses for the version of the root package.json. It never
// commits, pushes or starts a workflow.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'hoanghainh1188/agentic-sdlc-framework';
const root = process.cwd();
const fail = (msg) => {
  process.stderr.write(`release:lock: ${msg}\n`);
  process.exit(1);
};

const runId = process.argv[2];
if (!runId || !/^\d+$/.test(runId) || process.argv.length > 3)
  fail('usage: pnpm release:lock <run-id>');

const gh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.error || r.status !== 0)
    fail(`gh ${args[0]} ${args[1]} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
};

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const run = JSON.parse(
  gh([
    'run',
    'view',
    runId,
    '--repo',
    REPO,
    '--json',
    'workflowName,headBranch,event,status,conclusion',
  ]),
);
if (run.workflowName !== 'release-images')
  fail(`run ${runId} is ${run.workflowName}, not release-images`);
if (run.headBranch !== 'main') fail(`run ${runId} ran on ${run.headBranch}, not main`);
if (run.event !== 'workflow_dispatch')
  fail(`run ${runId} was started by ${run.event}, not a person`);
if (run.status !== 'completed' || run.conclusion !== 'success') {
  fail(`run ${runId} is ${run.status}/${run.conclusion ?? 'none'}, not completed/success`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-release-lock-'));
try {
  gh(['run', 'download', runId, '--repo', REPO, '--name', `images-lock-${version}`, '--dir', dir]);
  const file = path.join(dir, 'images.lock');
  if (!fs.existsSync(file)) fail(`the artifact images-lock-${version} holds no images.lock`);
  const check = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, 'release-check.mjs'), 'lock', file, version],
    { stdio: 'inherit' },
  );
  if (check.status !== 0) fail(`the lock file of run ${runId} is refused for ${version}`);
  fs.copyFileSync(file, path.join(root, 'platform/deploy/images.lock'));
  process.stdout.write(`release:lock: platform/deploy/images.lock = run ${runId} (v${version})\n`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
