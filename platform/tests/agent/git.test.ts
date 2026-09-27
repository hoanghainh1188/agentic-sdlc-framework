// D-08 C05 AC4, QUESTIONS #80: the platform's Git commands in the sandbox (commit what the agent
// left, list the changed files) and how their answers are read (ADR-M29).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  commitCommand,
  diffCommand,
  parseCommitOutput,
  parseDiffOutput,
  unquoteGitPath,
} from '@sdlc/adapter-agent-openhands';
import { AgentError } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const AUTHOR = { name: 'sdlc-agent', email: 'agent-6666@agents.sdlc.invalid' };
const BRANCH = 'agent/INT-2026-0001';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AgentError ? error.code : 'other';
  }
  return undefined;
}

describe('commitCommand', () => {
  it.each([
    ['a branch outside agent/INT-…', { branch: 'main' }],
    ['a quote in the branch', { branch: "agent/INT-2026-0001'" }],
    ['a quote in the author', { author: { name: "x' ; rm -rf /", email: AUTHOR.email } }],
    ['a command in the email', { author: { name: 'x', email: '$(id)@x.invalid' } }],
    ['a newline in the message', { message: 'a\nb' }],
    ['a relative working dir', { workingDir: 'workspace' }],
  ])('refuses %s', (_, change) => {
    const input = {
      workingDir: '/workspace',
      branch: BRANCH,
      author: AUTHOR,
      message: 'm',
      ...change,
    };
    expect(code(() => commitCommand(input))).toBe('invalid_input');
  });
});

describe('parseCommitOutput / parseDiffOutput', () => {
  it('reads the markers only, ignoring other output', () => {
    const sha = 'f'.repeat(40);
    expect(parseCommitOutput(`noise\nsdlc:committed\nsdlc:head:${sha}\n`)).toEqual({
      branchChanged: false,
      committed: true,
      headSha: sha,
    });
    expect(parseCommitOutput('sdlc:head:not-a-sha')).toMatchObject({ headSha: undefined });
    expect(parseCommitOutput('sdlc:branch_changed\n')).toMatchObject({ branchChanged: true });
  });

  it('fails closed on a diff without markers or with an unknown status', () => {
    expect(code(() => parseDiffOutput('A\tx\n'))).toBe('invalid_response');
    const sha = 'f'.repeat(40);
    expect(
      code(() => parseDiffOutput(`sdlc:head:${sha}\nsdlc:changes\nR100\ta\tb\nsdlc:end\n`)),
    ).toBe('invalid_response');
  });

  it('unquotes C-quoted paths (tabs, quotes, UTF-8 octal escapes)', () => {
    expect(unquoteGitPath('plain.txt')).toBe('plain.txt');
    expect(unquoteGitPath('"a\\tb\\"c"')).toBe('a\tb"c');
    expect(unquoteGitPath('"\\346\\227\\245.md"')).toBe('日.md');
    expect(code(() => unquoteGitPath('"bad\\q"'))).toBe('invalid_response');
  });
});

// The commands against a real Git repository, run with /bin/sh as the Agent Server does.
describe('commit and diff commands on a real repository', () => {
  let dir: string;
  let base: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  const sh = (command: string) => {
    try {
      return { code: 0, out: execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }) };
    } catch (error) {
      const e = error as { status: number; stdout: string };
      return { code: e.status, out: e.stdout };
    }
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c05-git-'));
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
    fs.writeFileSync(path.join(dir, 'old.txt'), 'old\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', BRANCH);
    // A hook that would run on commit: the platform's commit must never run it.
    fs.writeFileSync(
      path.join(dir, '.git/hooks/pre-commit'),
      '#!/bin/sh\ntouch hook-ran\nexit 1\n',
      {
        mode: 0o755,
      },
    );
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const commit = () =>
    sh(
      commitCommand({
        workingDir: dir,
        branch: BRANCH,
        author: AUTHOR,
        message: 'sdlc: agent run x',
      }),
    );

  it('commits only what the agent left, with the agent author, without hooks (#80)', () => {
    // The agent committed one change itself and left another uncommitted.
    fs.writeFileSync(path.join(dir, 'agent-commit.txt'), 'by agent\n');
    git('add', 'agent-commit.txt');
    git('commit', '-q', '--no-verify', '-m', 'agent work');
    fs.writeFileSync(path.join(dir, 'left.txt'), 'left\n');
    fs.writeFileSync(path.join(dir, 'tab\tname.txt'), 'x\n');
    fs.rmSync(path.join(dir, 'old.txt'));

    const result = commit();
    expect(result.code).toBe(0);
    const answer = parseCommitOutput(result.out);
    expect(answer.committed).toBe(true);
    expect(answer.headSha).toBe(git('rev-parse', 'HEAD'));
    expect(git('log', '-1', '--format=%an <%ae>|%cn <%ce>|%s')).toBe(
      `${AUTHOR.name} <${AUTHOR.email}>|${AUTHOR.name} <${AUTHOR.email}>|sdlc: agent run x`,
    );
    expect(fs.existsSync(path.join(dir, 'hook-ran'))).toBe(false);

    // Nothing left: no second commit, same HEAD.
    const again = parseCommitOutput(commit().out);
    expect(again).toMatchObject({ committed: false, headSha: answer.headSha });
  });

  it('lists every file changed since base_sha, both commits included (AC4)', () => {
    const answer = parseDiffOutput(sh(diffCommand(dir, base)).out);
    expect(answer.headSha).toBe(git('rev-parse', 'HEAD'));
    expect(answer.changedFiles).toEqual(
      expect.arrayContaining([
        { path: 'agent-commit.txt', status: 'added' },
        { path: 'left.txt', status: 'added' },
        { path: 'tab\tname.txt', status: 'added' },
        { path: 'old.txt', status: 'deleted' },
      ]),
    );
    expect(answer.changedFiles).toHaveLength(4);
  });

  it('ignores replace refs the agent could use to hide changes', () => {
    // Replace the HEAD commit with the base commit: plain git would then show no changes.
    const head = git('rev-parse', 'HEAD');
    git('replace', head, base);
    const answer = parseDiffOutput(sh(diffCommand(dir, base)).out);
    expect(answer.headSha).toBe(head);
    expect(answer.changedFiles.length).toBeGreaterThan(0);
    git('replace', '-d', head);
  });

  it('refuses to commit when the agent left the branch', () => {
    git('checkout', '-q', '-b', 'other');
    const result = commit();
    expect(result.code).toBe(3);
    expect(parseCommitOutput(result.out).branchChanged).toBe(true);
    git('checkout', '-q', BRANCH);
  });
});
