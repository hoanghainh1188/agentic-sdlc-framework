// `build.sh --no-push` prints a reference by digest only for the tag's own repository (no Docker
// needed: a fake `docker` on PATH answers `inspect` with the RepoDigests of the test).
// On the classic image store an image pushed earlier to another throw-away registry keeps that
// registry's digest in RepoDigests. Printing it gave the agent tests a stale reference, and the
// OpenCode image built on it sometimes had no digest at all: the runner refused it with
// `image_unavailable` (CI job `sandbox image (node24)`).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { root } from './compose';

const BUILD = path.join(root, 'platform/sandbox-images/build.sh');
const REGISTRY = 'sdlc-test';
const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-build-digest-'));
fs.writeFileSync(
  path.join(bin, 'docker'),
  [
    '#!/bin/sh',
    'if [ "$1" = "inspect" ]; then printf "%s" "$FAKE_REPO_DIGESTS"; fi',
    'exit 0',
    '',
  ].join('\n'),
  { mode: 0o755 },
);
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

function buildNoPush(repoDigests: string[]): string {
  return execFileSync('sh', [BUILD, 'node24', '--no-push'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      SDLC_SANDBOX_REGISTRY: REGISTRY,
      FAKE_REPO_DIGESTS: repoDigests.map((line) => `${line}\n`).join(''),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

describe('build.sh --no-push: the printed reference', () => {
  it('is the digest of the tag’s own repository when the Engine has one (containerd store)', () => {
    const own = `${REGISTRY}/sdlc/sandbox-node24@sha256:${DIGEST}`;
    expect(buildNoPush([`localhost:32768/sdlc/sandbox-node24@sha256:${OTHER}`, own])).toBe(own);
  });

  it('is the tag, never another registry’s digest (classic store after an earlier push)', () => {
    const out = buildNoPush([
      `localhost:32768/sdlc/sandbox-node24@sha256:${OTHER}`,
      `localhost:32769/sdlc/sandbox-node24@sha256:${DIGEST}`,
    ]);
    expect(out).toMatch(new RegExp(`^${REGISTRY}/sdlc/sandbox-node24:[0-9a-z]+$`));
    expect(out).not.toContain('@sha256:');
  });

  it('is the tag when the Engine has no digest at all', () => {
    expect(buildNoPush([])).toMatch(new RegExp(`^${REGISTRY}/sdlc/sandbox-node24:[0-9a-z]+$`));
  });

  it('never takes another toolchain’s digest of the same registry', () => {
    const out = buildNoPush([`${REGISTRY}/sdlc/sandbox-node24-opencode@sha256:${DIGEST}`]);
    expect(out).not.toContain('@sha256:');
  });
});
