// Git work inside the sandbox, through the Agent Server's bash endpoint (design/ADR-M29,
// QUESTIONS #80). Pure builders and parsers, so tests can check every command and every answer.
//
// - Every value that goes into a command is checked against a strict pattern first and then put
//   in single quotes, so nothing from the contract or the agent can change the command.
// - The platform's commit runs without hooks and without signing, with a fixed author that names
//   the agent (G7 counts the agent as a producer, FR-11).
// - Answers are read from marker lines (`sdlc:…`) only; anything else in the output is ignored,
//   and a missing marker fails closed.
// - Git runs by absolute path, with no system or global configuration, no replace refs and none of
//   the `GIT_*` variables that move the repository. The agent still controls the sandbox, so these
//   answers are what the sandbox reports: G5 and the push (C07, C08) recompute the changed files
//   from the pushed branch outside the sandbox before they trust them (ADR-M29 §2.5).
import { AgentError, type AgentCommitAuthor, type ChangedFile } from '@sdlc/contracts';

const BRANCH = /^agent\/INT-[0-9]{4}-[0-9]{4,9}$/;
const AUTHOR_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const AUTHOR_EMAIL = /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MESSAGE = /^[A-Za-z0-9][A-Za-z0-9 ._:/()-]{0,199}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const WORKING_DIR = /^\/[A-Za-z0-9_./-]{0,255}$/;

/** Where Git is in the sandbox images (the Agent Server base, ADR-M25 §2.9). */
export const SANDBOX_GIT = '/usr/bin/git';

/** `git` with no hooks, no pager, no signing and no replace refs, whatever the agent configured. */
const GIT = `${SANDBOX_GIT} --no-replace-objects -c core.hooksPath=/dev/null -c core.pager=cat -c commit.gpgsign=false -c core.fsmonitor=false`;

/** First lines of every command: a clean Git environment. */
const PRELUDE = [
  'set -u',
  'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1',
  'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT',
];

function checked(value: string, pattern: RegExp, field: string): string {
  if (!pattern.test(value) || value.includes("'")) throw new AgentError('invalid_input', { field });
  return value;
}

/**
 * Commits what the agent left on `branch`. Output markers: `sdlc:branch_changed` (exit 3),
 * `sdlc:nothing` or `sdlc:committed`, then `sdlc:head:<sha>`.
 */
export function commitCommand(input: {
  readonly workingDir: string;
  readonly branch: string;
  readonly author: AgentCommitAuthor;
  readonly message: string;
}): string {
  const dir = checked(input.workingDir, WORKING_DIR, 'working_dir');
  const branch = checked(input.branch, BRANCH, 'branch');
  const name = checked(input.author.name, AUTHOR_NAME, 'author.name');
  const email = checked(input.author.email, AUTHOR_EMAIL, 'author.email');
  const message = checked(input.message, MESSAGE, 'message');
  const identity = `-c user.name='${name}' -c user.email='${email}'`;
  return [
    ...PRELUDE,
    `cd '${dir}' || exit 2`,
    `current="$(${GIT} symbolic-ref --quiet --short HEAD || true)"`,
    `if [ "$current" != '${branch}' ]; then echo sdlc:branch_changed; exit 3; fi`,
    `${GIT} add -A || exit 4`,
    `if ${GIT} diff --cached --quiet; then echo sdlc:nothing; else ` +
      `${GIT} ${identity} commit --quiet --no-verify --author='${name} <${email}>' -m '${message}' || exit 5; ` +
      'echo sdlc:committed; fi',
    `echo "sdlc:head:$(${GIT} rev-parse HEAD)"`,
  ].join('\n');
}

export interface CommitAnswer {
  readonly branchChanged: boolean;
  readonly committed: boolean;
  readonly headSha: string | undefined;
}

export function parseCommitOutput(stdout: string): CommitAnswer {
  const lines = stdout.split('\n').map((line) => line.trim());
  const head = lines.find((line) => line.startsWith('sdlc:head:'))?.slice('sdlc:head:'.length);
  return {
    branchChanged: lines.includes('sdlc:branch_changed'),
    committed: lines.includes('sdlc:committed'),
    headSha: head && GIT_SHA.test(head) ? head : undefined,
  };
}

/**
 * Lists the files changed between `baseSha` and `HEAD`. Renames are shown as delete + add
 * (`--no-renames`), so G5 sees both paths. Paths are C-quoted by Git when unusual (`core.quotePath`).
 */
export function diffCommand(workingDir: string, baseSha: string): string {
  const dir = checked(workingDir, WORKING_DIR, 'working_dir');
  const base = checked(baseSha, GIT_SHA, 'base_sha');
  return [
    ...PRELUDE,
    `cd '${dir}' || exit 2`,
    `${GIT} cat-file -e '${base}^{commit}' || { echo sdlc:no_base; exit 3; }`,
    `echo "sdlc:head:$(${GIT} rev-parse HEAD)"`,
    'echo sdlc:changes',
    `${GIT} -c core.quotePath=true diff --no-renames --name-status '${base}' HEAD || exit 4`,
    'echo sdlc:end',
  ].join('\n');
}

const STATUS: Readonly<Record<string, ChangedFile['status']>> = {
  A: 'added',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
};

/** Reverses Git's C-style quoting of a path (`"a\tb"`, octal escapes for non-ASCII bytes). */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  if (raw.length < 2 || !raw.endsWith('"'))
    throw new AgentError('invalid_response', { field: 'path' });
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Readonly<Record<string, number>> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (next in simple) {
      bytes.push(simple[next]!);
      i += 1;
    } else {
      throw new AgentError('invalid_response', { field: 'path' });
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export interface DiffAnswer {
  readonly headSha: string;
  readonly changedFiles: ChangedFile[];
}

export function parseDiffOutput(stdout: string): DiffAnswer {
  const lines = stdout.split('\n');
  const head = lines
    .find((line) => line.startsWith('sdlc:head:'))
    ?.slice('sdlc:head:'.length)
    .trim();
  const start = lines.indexOf('sdlc:changes');
  const end = lines.indexOf('sdlc:end');
  if (!head || !GIT_SHA.test(head) || start < 0 || end < start) {
    throw new AgentError('invalid_response', { field: 'git_diff' });
  }
  const changedFiles = lines.slice(start + 1, end).flatMap((line): ChangedFile[] => {
    if (line === '') return [];
    const tab = line.indexOf('\t');
    const status = STATUS[line.slice(0, tab)];
    if (tab < 0 || !status) throw new AgentError('invalid_response', { field: 'git_diff' });
    return [{ path: unquoteGitPath(line.slice(tab + 1)), status }];
  });
  return { headSha: head, changedFiles };
}
