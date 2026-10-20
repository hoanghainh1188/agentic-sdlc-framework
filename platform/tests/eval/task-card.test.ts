// Task L07 (ADR-M85 §2.1–§2.4): a project's own evaluation task is a card made from a merged
// intent. AC1: the card holds the base commit, the spec reference and the tests the pull request
// added or changed as hidden tests. AC4: a fixture intent gives a card; a pull request without a
// test is refused. Merge, squash and rebase merges find their base (QUESTIONS #485).
import {
  draftTaskCard,
  findBaseCommit,
  isTestFile,
  parseTaskCard,
  renderTaskCard,
  taskCardPath,
  TaskError,
  type CommitLookup,
  type DraftInput,
  type MergedPullRequest,
  type TaskCard,
} from '@sdlc/eval';
import { describe, expect, it } from 'vitest';

const sha = (c: string) => c.repeat(40);
const BASE = sha('b');
const MERGE = sha('c');
const MAIN_BEFORE = sha('d');
const FIRST = sha('e');
const SPEC = { path: 'docs/specs/T06 tax.md', commit: sha('f'), sha256: 'a'.repeat(64) };
const GLOBS = ['**/*.test.*', '**/*.spec.*', 'test/**'];
const COMMANDS = {
  fail_to_pass: ['pnpm --filter @pilot/api test -- {file}'],
  pass_to_pass: ['pnpm --filter @pilot/api test'],
  ci: ['pnpm --filter @pilot/api typecheck', 'pnpm lint'],
};

/** The fixture intent's merged pull request: one source file, one new test, one changed test. */
const FILES: MergedPullRequest['files'] = [
  { path: 'apps/api/src/orders/order-rules.spec.ts', status: 'modified', previousPath: null },
  { path: 'apps/api/src/orders/order-rules.ts', status: 'modified', previousPath: null },
  { path: 'apps/api/src/orders/tax.spec.ts', status: 'added', previousPath: null },
];
const FILE_PATHS = FILES.map((f) => f.path);

/** A Git history: parents by commit, and the files between two commits. */
function lookup(
  parents: Record<string, string[]>,
  compare: Record<string, readonly string[]>,
): CommitLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getCommitParents: (commit) => {
      calls.push(`parents ${commit}`);
      return Promise.resolve(parents[commit] ?? []);
    },
    compareChangedFiles: (base, head) => {
      calls.push(`compare ${base}..${head}`);
      return Promise.resolve(compare[`${base}..${head}`] ?? ['other.ts']);
    },
  };
}

function input(change: Partial<MergedPullRequest> = {}): DraftInput {
  return {
    id: 'tax-rule',
    intent: 'INT-2026-0006',
    change: {
      mergeCommitSha: MERGE,
      mergeCommitParents: [BASE, sha('9')],
      commitCount: 2,
      files: FILES,
      ...change,
    },
    spec: SPEC,
    testGlobs: GLOBS,
    commands: COMMANDS,
  };
}

const merged = lookup({}, { [`${BASE}..${MERGE}`]: FILE_PATHS });

describe('drafting a task card from a merged intent (AC1, AC4)', () => {
  it('makes a card from the fixture intent: base, spec, hidden tests, planned files, commands', async () => {
    const result = await draftTaskCard(input(), merged);
    expect(result).toEqual({
      ok: true,
      card: {
        id: 'tax-rule',
        intent: 'INT-2026-0006',
        baseCommit: BASE,
        mergeCommit: MERGE,
        spec: SPEC,
        hiddenTests: ['apps/api/src/orders/order-rules.spec.ts', 'apps/api/src/orders/tax.spec.ts'],
        plannedFiles: ['apps/api/src/orders/order-rules.ts'],
        failToPass: [
          'pnpm --filter @pilot/api test -- apps/api/src/orders/order-rules.spec.ts',
          'pnpm --filter @pilot/api test -- apps/api/src/orders/tax.spec.ts',
        ],
        passToPass: ['pnpm --filter @pilot/api test'],
        ci: ['pnpm --filter @pilot/api typecheck', 'pnpm lint'],
      },
    });
  });

  it('refuses a pull request that added or changed no test (no_tests)', async () => {
    const files = [FILES[1]!];
    const result = await draftTaskCard(
      input({ files }),
      lookup({}, { [`${BASE}..${MERGE}`]: [files[0]!.path] }),
    );
    expect(result).toEqual({ ok: false, code: 'no_tests' });
  });

  it('does not count a removed test as a hidden test', async () => {
    const files: MergedPullRequest['files'] = [
      { path: 'src/a.ts', status: 'modified', previousPath: null },
      { path: 'src/old.test.ts', status: 'removed', previousPath: null },
    ];
    expect(await draftTaskCard(input({ files }), merged)).toEqual({ ok: false, code: 'no_tests' });
  });

  it('refuses a pull request that changed only tests (no_planned_files)', async () => {
    const files = [FILES[2]!];
    expect(await draftTaskCard(input({ files }), merged)).toEqual({
      ok: false,
      code: 'no_planned_files',
    });
  });

  it('refuses an unclear base (base_unclear)', async () => {
    expect(await draftTaskCard(input(), lookup({}, {}))).toEqual({
      ok: false,
      code: 'base_unclear',
    });
  });

  it('refuses more than 20 files of a kind, and a path a card cannot hold', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      path: `src/f${String(i)}.ts`,
      status: 'added' as const,
      previousPath: null,
    }));
    expect(await draftTaskCard(input({ files: [...many, FILES[2]!] }), merged)).toEqual({
      ok: false,
      code: 'too_many_files',
    });
    const odd = [{ path: 'src/a$b.ts', status: 'added' as const, previousPath: null }, FILES[2]!];
    expect(await draftTaskCard(input({ files: odd }), merged)).toEqual({
      ok: false,
      code: 'unsafe_path',
    });
  });

  it('keeps empty commands when the configuration proposes none', async () => {
    const result = await draftTaskCard(
      { ...input(), commands: { fail_to_pass: [], pass_to_pass: [], ci: [] } },
      merged,
    );
    expect(result.ok && [result.card.failToPass, result.card.passToPass, result.card.ci]).toEqual([
      [],
      [],
      [],
    ]);
  });

  it('refuses a wrong task ID or intent code', async () => {
    await expect(draftTaskCard({ ...input(), id: 'Tax Rule' }, merged)).rejects.toThrow(TaskError);
    await expect(draftTaskCard({ ...input(), intent: 'INT-1' }, merged)).rejects.toThrow(TaskError);
  });
});

describe('the base commit (ADR-M85 §2.3, QUESTIONS #485)', () => {
  const RENAMED: MergedPullRequest['files'] = [
    { path: 'src/new.ts', status: 'renamed', previousPath: 'src/old.ts' },
    { path: 'src/new.test.ts', status: 'added', previousPath: null },
  ];
  const RENAMED_PATHS = ['src/new.test.ts', 'src/new.ts', 'src/old.ts'];

  it('a merge commit: its first parent', async () => {
    const change = {
      mergeCommitSha: MERGE,
      mergeCommitParents: [BASE, FIRST],
      commitCount: 5,
      files: RENAMED,
    };
    const git = lookup({}, { [`${BASE}..${MERGE}`]: RENAMED_PATHS });
    expect(await findBaseCommit(change, git)).toBe(BASE);
    expect(git.calls).toEqual([`compare ${BASE}..${MERGE}`]);
  });

  it('a squash merge: the parent, when the commit far back does not match', async () => {
    const change = {
      mergeCommitSha: MERGE,
      mergeCommitParents: [MAIN_BEFORE],
      commitCount: 2,
      files: RENAMED,
    };
    const git = lookup(
      { [MERGE]: [MAIN_BEFORE], [MAIN_BEFORE]: [BASE] },
      {
        [`${MAIN_BEFORE}..${MERGE}`]: RENAMED_PATHS,
        [`${BASE}..${MERGE}`]: [...RENAMED_PATHS, 'x.ts'],
      },
    );
    expect(await findBaseCommit(change, git)).toBe(MAIN_BEFORE);
  });

  it('a rebase merge: the commit `commitCount` steps back', async () => {
    const change = {
      mergeCommitSha: MERGE,
      mergeCommitParents: [FIRST],
      commitCount: 2,
      files: RENAMED,
    };
    const git = lookup(
      { [MERGE]: [FIRST], [FIRST]: [BASE] },
      {
        [`${FIRST}..${MERGE}`]: ['src/new.ts', 'src/old.ts'],
        [`${BASE}..${MERGE}`]: RENAMED_PATHS,
      },
    );
    expect(await findBaseCommit(change, git)).toBe(BASE);
  });

  it('two candidates that both match, or none, are unclear', async () => {
    const change = {
      mergeCommitSha: MERGE,
      mergeCommitParents: [FIRST],
      commitCount: 2,
      files: RENAMED,
    };
    const both = lookup(
      { [MERGE]: [FIRST], [FIRST]: [BASE] },
      { [`${FIRST}..${MERGE}`]: RENAMED_PATHS, [`${BASE}..${MERGE}`]: RENAMED_PATHS },
    );
    expect(await findBaseCommit(change, both)).toBeNull();
    expect(
      await findBaseCommit(change, lookup({ [MERGE]: [FIRST], [FIRST]: [BASE] }, {})),
    ).toBeNull();
  });

  it('a merge commit inside the chain, too many commits or odd parents are unclear', async () => {
    const files = RENAMED;
    const chainWithMerge = lookup(
      { [MERGE]: [FIRST], [FIRST]: [BASE, sha('9')] },
      { [`${FIRST}..${MERGE}`]: ['x.ts'] },
    );
    expect(
      await findBaseCommit(
        { mergeCommitSha: MERGE, mergeCommitParents: [FIRST], commitCount: 2, files },
        chainWithMerge,
      ),
    ).toBeNull();
    expect(
      await findBaseCommit(
        { mergeCommitSha: MERGE, mergeCommitParents: [FIRST], commitCount: 51, files },
        lookup({}, {}),
      ),
    ).toBeNull();
    for (const parents of [[], [BASE, FIRST, MAIN_BEFORE]]) {
      expect(
        await findBaseCommit(
          { mergeCommitSha: MERGE, mergeCommitParents: parents, commitCount: 1, files },
          lookup({}, {}),
        ),
      ).toBeNull();
    }
  });
});

describe('reading and writing a task card (ADR-M85 §2.1)', () => {
  const card: TaskCard = {
    id: 'tax-rule',
    intent: 'INT-2026-0006',
    baseCommit: BASE,
    mergeCommit: MERGE,
    spec: SPEC,
    hiddenTests: ['apps/api/src/orders/tax.spec.ts'],
    plannedFiles: ['apps/api/src/orders/order-rules.ts'],
    failToPass: ['pnpm --filter @pilot/api test -- apps/api/src/orders/tax.spec.ts'],
    passToPass: ['pnpm --filter @pilot/api test'],
    ci: ['pnpm lint'],
  };
  const PATH = taskCardPath('tax-rule');

  it('the card path is .sdlc/eval-tasks/<id>.yaml', () => {
    expect(PATH).toBe('.sdlc/eval-tasks/tax-rule.yaml');
  });

  it('round-trips: what is written is read back the same', () => {
    expect(parseTaskCard(renderTaskCard(card), PATH)).toEqual(card);
  });

  it('holds codes, commits, paths and commands only (no title, no text)', () => {
    const text = renderTaskCard(card);
    expect(text).not.toMatch(/title|description|body/);
    expect(
      text.split('\n').filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith(' ')),
    ).toHaveLength(11);
  });

  const variants: [string, (text: string) => string, string | RegExp][] = [
    ['an unknown field', (t) => `${t}title: Tax rule\n`, 'unknown field title'],
    ['another schema', (t) => t.replace('schema: 2', 'schema: 1'), 'schema must be 2'],
    [
      'empty commands (a draft not filled in)',
      (t) => t.replace(/ci:\n {2}- "pnpm lint"/, 'ci: []'),
      'ci must be a list',
    ],
    ['a shell command', (t) => t.replace('"pnpm lint"', '"pnpm lint; rm -rf /"'), 'ci[0]'],
    [
      'a path outside the repository',
      (t) => t.replace('"apps/api/src/orders/tax.spec.ts"', '"../x.spec.ts"'),
      'hidden_tests[0]',
    ],
    [
      'the same commit twice',
      (t) => t.replace(`merge_commit: ${MERGE}`, `merge_commit: ${BASE}`),
      'must differ',
    ],
    ['a short spec hash', (t) => t.replace('a'.repeat(64), 'abc'), 'spec.sha256'],
    ['not YAML', () => 'id: [', 'not valid YAML'],
  ];
  it.each(variants)('refuses %s', (_name, change, message) => {
    expect(() => parseTaskCard(change(renderTaskCard(card)), PATH)).toThrow(message);
  });

  it('refuses a card whose path is not its ID, and a file both test and planned', () => {
    expect(() => parseTaskCard(renderTaskCard(card), '.sdlc/eval-tasks/other.yaml')).toThrow(
      'the path must be .sdlc/eval-tasks/tax-rule.yaml',
    );
    const overlap = { ...card, plannedFiles: [...card.plannedFiles, ...card.hiddenTests] };
    expect(() => parseTaskCard(renderTaskCard(overlap), PATH)).toThrow(
      'is both a hidden test and a planned file',
    );
  });
});

describe('test files (evaluation.tasks.test_globs)', () => {
  it.each([
    ['apps/api/src/a.spec.ts', true],
    ['a.test.js', true],
    ['test/helpers.ts', true],
    ['apps/api/src/a.ts', false],
    ['apps/api/test/a.ts', false],
  ])('%s → %s', (file, expected) => {
    expect(isTestFile(file, GLOBS)).toBe(expected);
  });
});
