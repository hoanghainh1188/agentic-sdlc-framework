#!/usr/bin/env node
// What release-tag.yml does on a push to main (ADR-M104 §2.2), decided from the state of the
// repository, never from the last commit alone, so a run that GitHub cancels while it waits, a push
// of several commits, or a run that failed after the tag, still ends in one release:
// - the version of package.json has no tag: it must be above every tag vX.Y.Z; the release gate
//   runs; the tag is created through the API at the commit that set the version; release.yml is
//   dispatched on the tag (a tag made with GITHUB_TOKEN starts no workflow, a dispatch does);
// - it has a tag but no run of release.yml on it: the release is dispatched;
// - it has a tag and a run: nothing to do.
// Needs the history of package.json (checkout with fetch-depth 0), `gh` and GH_TOKEN. Prints
// codes, versions and commit IDs only.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parts(v) {
  return VERSION.exec(v).slice(1).map(Number);
}

function above(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** `tag`, `dispatch`, `none` or `refuse` (with a reason). */
export function decideTag({ version, tags, releaseRuns }) {
  const released = tags.map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t)?.[1]).filter(Boolean);
  if (released.includes(version)) {
    return releaseRuns > 0
      ? { action: 'none', reason: `v${version} is tagged and release.yml ran on it` }
      : { action: 'dispatch' };
  }
  const highest = released.reduce((top, v) => (top === null || above(v, top) ? v : top), null);
  if (highest !== null && !above(version, highest)) {
    return { action: 'refuse', reason: `v${version} is not above the newest tag v${highest}` };
  }
  return { action: 'tag' };
}

/** The commit that set `version`: the oldest of the newest commits that all hold it. */
export function bumpCommit(history, version) {
  let found = null;
  for (const entry of history) {
    if (entry.version !== version) break;
    found = entry.sha;
  }
  return found;
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function say(line) {
  process.stdout.write(`${line}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  if (!VERSION.test(version)) throw new Error(`package.json version ${version} is not X.Y.Z`);
  const tags = run('git', ['ls-remote', '--tags', 'origin', 'refs/tags/v*'])
    .split('\n')
    .map((line) => line.split('\trefs/tags/')[1])
    .filter((t) => t && !t.endsWith('^{}'));
  const releaseRuns = tags.includes(`v${version}`)
    ? Number(
        run('gh', [
          'run',
          'list',
          '--workflow',
          'release.yml',
          '--branch',
          `v${version}`,
          '--json',
          'databaseId',
          '--jq',
          'length',
        ]),
      )
    : 0;
  const decision = decideTag({ version, tags, releaseRuns });
  if (decision.action === 'none') return say(decision.reason);
  if (decision.action === 'refuse') {
    say(`::error::${decision.reason}`);
    process.exitCode = 1;
    return undefined;
  }
  if (decision.action === 'tag') {
    const shas = run('git', ['log', '--format=%H', '-n', '200', '--', 'package.json']).split('\n');
    const history = shas.map((sha) => ({
      sha,
      version: JSON.parse(run('git', ['show', `${sha}:package.json`])).version,
    }));
    const sha = bumpCommit(history, version);
    if (!sha) throw new Error(`no commit sets version ${version}`);
    const gate = spawnSync(
      'node',
      [path.join(import.meta.dirname, 'release-check.mjs'), 'tag', `v${version}`],
      { stdio: 'inherit' },
    );
    if (gate.status !== 0) {
      process.exitCode = 1;
      return undefined;
    }
    run('gh', [
      'api',
      `repos/${repo}/git/refs`,
      '-f',
      `ref=refs/tags/v${version}`,
      '-f',
      `sha=${sha}`,
    ]);
    say(`Tagged v${version} at ${sha}.`);
  }
  run('gh', ['workflow', 'run', 'release.yml', '--ref', `v${version}`]);
  say(`Started release.yml on v${version}.`);
  return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
