// B09 PR 2 (ADR-M40 §2.7, QUESTIONS #169): the runner reads the plan file at the plan's commit from
// its own clone with hardened git, never from the sandbox and never over the network. A real
// repository: the stored bytes, a missing commit, a missing file, a folder, a link, a large file.
// Also the rendering of the tasks' text with its caps (cleaned, cut per field and in total).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PLAN_FIELD_MAX_CHARS,
  PLAN_TASK_TEXT_MAX_CHARS,
  readPlanBlob,
  renderPlanTasks,
} from '../../apps/runner/src/index.js';

const FILE = '.sdlc/plans/INT-2026-0007.yaml';
const BYTES = Buffer.from('﻿plan:\r\n  intent_id: INT-2026-0007\r\n', 'utf8');
let root: string;
let commit: string;
let later: string;

function git(args: string[]): string {
  return execFileSync('git', ['-C', path.join(root, 'repo'), ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  })
    .toString()
    .trim();
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-file-'));
  fs.mkdirSync(path.join(root, 'home'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.sdlc/plans'), { recursive: true });
  git(['init', '-q']);
  fs.writeFileSync(path.join(repo, FILE), BYTES);
  git(['-c', 'core.autocrlf=false', 'add', '-A']);
  // An attribute that would change the file if a filter ran on read: `cat-file blob` returns the
  // stored bytes. Added after the file, so `git add` stored the bytes as they are.
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.yaml text eol=lf\n');
  git(['add', '.gitattributes']);
  git(['commit', '-q', '-m', 'plan']);
  commit = git(['rev-parse', 'HEAD']);
  fs.rmSync(path.join(repo, FILE));
  fs.mkdirSync(path.join(repo, '.sdlc/plans/INT-2026-0008.yaml'));
  fs.writeFileSync(path.join(repo, '.sdlc/plans/INT-2026-0008.yaml/x'), 'x');
  fs.symlinkSync('../../README.md', path.join(repo, '.sdlc/plans/INT-2026-0009.yaml'));
  fs.writeFileSync(path.join(repo, '.sdlc/plans/INT-2026-0010.yaml'), 'a'.repeat(64 * 1024 + 1));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'later']);
  later = git(['rev-parse', 'HEAD']);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('readPlanBlob', () => {
  it('returns the stored bytes at the commit (BOM and CRLF kept)', async () => {
    const read = await readPlanBlob(root, commit, FILE, 10_000);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.bytes.equals(BYTES)).toBe(true);
  });

  it('a commit that is not in the clone: commit_missing (nothing is fetched)', async () => {
    expect(await readPlanBlob(root, 'f'.repeat(40), FILE, 10_000)).toEqual({
      kind: 'unreadable',
      cause: 'commit_missing',
    });
  });

  it('missing at the commit, a folder, a link, a large file', async () => {
    const cause = async (file: string) => {
      const read = await readPlanBlob(root, later, file, 10_000);
      return read.kind === 'unreadable' ? read.cause : 'ok';
    };
    expect(await cause(FILE)).toBe('missing');
    expect(await cause('.sdlc/plans/INT-2026-0008.yaml')).toBe('not_a_file');
    expect(await cause('.sdlc/plans/INT-2026-0009.yaml')).toBe('not_a_file');
    expect(await cause('.sdlc/plans/INT-2026-0010.yaml')).toBe('too_large');
  });

  it('git that cannot answer (killed at its timeout): git_failed, never commit_missing', async () => {
    // A fake `git` first on PATH that never answers (`exec`, so the timeout's signal kills it and
    // nothing keeps the pipe open): deterministic, whatever the machine's speed.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-git-'));
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
    const original = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${original ?? ''}`;
    try {
      expect(await readPlanBlob(root, commit, FILE, 300)).toEqual({
        kind: 'unreadable',
        cause: 'git_failed',
      });
    } finally {
      process.env.PATH = original;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('refuses anything but a plan path and a commit SHA before git runs', async () => {
    for (const [sha, file] of [
      [commit, 'README.md'],
      [commit, '.sdlc/plans/../x.yaml'],
      ['HEAD', FILE],
      [`${commit} --output=/tmp/x`, FILE],
    ] as const) {
      expect(await readPlanBlob(root, sha, file, 10_000)).toEqual({
        kind: 'unreadable',
        cause: 'missing',
      });
    }
  });
});

describe('renderPlanTasks', () => {
  it('plain lines per task; lists as items; unsafe characters replaced', () => {
    const rendered = renderPlanTasks([
      {
        id: 'T1',
        fields: [
          { name: 'summary', values: ['Cancel‮ an order\r\n'], list: false },
          { name: 'definition_of_done', values: ['AC1 passes', 'lint passes'], list: true },
        ],
      },
      { id: 'T2', fields: [] },
    ]);
    expect(rendered).toEqual({
      text:
        'Task T1\nsummary: Cancel  an order\ndefinition of done:\n- AC1 passes\n- lint passes' +
        '\n\nTask T2',
      truncated: false,
    });
  });

  it('cuts a field at PLAN_FIELD_MAX_CHARS and the whole text at PLAN_TASK_TEXT_MAX_CHARS', () => {
    const long = renderPlanTasks([
      { id: 'T1', fields: [{ name: 'summary', values: ['x'.repeat(5000)], list: false }] },
    ]);
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual('Task T1\n'.length + PLAN_FIELD_MAX_CHARS);
    expect(long.text).toContain('[The platform cut this field here.]');

    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: `T${i}`,
      fields: (['summary', 'input', 'output'] as const).map((name) => ({
        name,
        values: ['y'.repeat(1500)],
        list: false,
      })),
    }));
    const total = renderPlanTasks(tasks);
    expect(total.truncated).toBe(true);
    expect(total.text.length).toBe(PLAN_TASK_TEXT_MAX_CHARS);
    expect(total.text.endsWith('[The platform cut the plan text here.]')).toBe(true);
  });
});
