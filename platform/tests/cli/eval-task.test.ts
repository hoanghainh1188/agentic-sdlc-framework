// `sdlc eval task …` (task L07, design/ADR-M85 §2.2, §2.6) against a mocked API:
// - `draft` writes the card `.sdlc/eval-tasks/<id>.yaml` in the repository folder from the API's
//   fields (AC4), never over an existing file without `--force`, never through a link;
// - `register`, `list`, `approve` and `reject` call their endpoints; `approve` and `reject` send
//   the card SHA-256 the reviewer saw (AC1); every command has `--json`.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseTaskCard } from '@sdlc/eval';
import { t } from '@sdlc/messages';
import { afterEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { useHarness } from './harness.js';

const harness = useHarness();
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const CARD = {
  id: 'tax-rule',
  intent: 'INT-2026-0006',
  base_commit: '1'.repeat(40),
  merge_commit: '2'.repeat(40),
  spec: { path: 'docs/specs/tax.md', commit: '4'.repeat(40), sha256: '5'.repeat(64) },
  hidden_tests: ['apps/api/src/tax.spec.ts'],
  planned_files: ['apps/api/src/tax.ts'],
  fail_to_pass: ['pnpm test -- apps/api/src/tax.spec.ts'],
  pass_to_pass: ['pnpm test'],
  ci: ['pnpm lint'],
};
const TASK = {
  id: '0b0e4c8a-6d4f-4e5c-9a3b-2f1d0c9b8a7e',
  task: 'tax-rule',
  intent: 'INT-2026-0006',
  card_path: '.sdlc/eval-tasks/tax-rule.yaml',
  card_commit: '3'.repeat(40),
  card_sha256: 'a'.repeat(64),
  base_commit: '1'.repeat(40),
  merge_commit: '2'.repeat(40),
  status: 'checked',
  check_code: null,
  created_at: '2026-10-20T08:00:00.000Z',
  updated_at: '2026-10-20T08:00:00.000Z',
};
const DRAFT = 'GET /v1/projects/shop/eval-tasks/draft';

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sdlc-eval-task-'));
  dirs.push(dir);
  await mkdir(path.join(dir, '.git'));
  await mkdir(path.join(dir, 'apps'));
  return dir;
}

describe('sdlc eval task draft (AC4)', () => {
  it('writes the card in the repository folder from the API fields', async () => {
    const dir = await repo();
    const h = await harness({
      cwd: path.join(dir, 'apps'),
      routes: { [DRAFT]: { status: 200, body: { card: CARD } } },
    });
    const code = await h.run([
      'eval',
      'task',
      'draft',
      'INT-2026-0006',
      '--project',
      'shop',
      '--task',
      'tax-rule',
    ]);
    expect(code, h.err.join('\n')).toBe(EXIT.ok);
    expect(h.requests[0]!.url.searchParams.get('intent')).toBe('INT-2026-0006');
    expect(h.requests[0]!.url.searchParams.get('task')).toBe('tax-rule');
    const file = path.join(dir, '.sdlc', 'eval-tasks', 'tax-rule.yaml');
    const card = parseTaskCard(await readFile(file, 'utf8'), '.sdlc/eval-tasks/tax-rule.yaml');
    expect(card).toMatchObject({ id: 'tax-rule', baseCommit: CARD.base_commit, ci: ['pnpm lint'] });
    const out = h.out.join('\n');
    expect(out).toContain(t('cli.eval.task.next', { project: 'shop', task: 'tax-rule' }));
    expect(out).not.toContain(t('cli.eval.task.fill_commands'));
  });

  it('says to fill the commands when the configuration proposes none', async () => {
    const dir = await repo();
    const h = await harness({
      cwd: dir,
      routes: { [DRAFT]: { status: 200, body: { card: { ...CARD, ci: [], pass_to_pass: [] } } } },
    });
    const args = [
      'eval',
      'task',
      'draft',
      'INT-2026-0006',
      '--project',
      'shop',
      '--task',
      'tax-rule',
    ];
    expect(await h.run(args)).toBe(EXIT.ok);
    expect(h.out.join('\n')).toContain(t('cli.eval.task.fill_commands'));
  });

  it('never replaces a file without --force, and never writes through a link', async () => {
    const dir = await repo();
    const routes = { [DRAFT]: { status: 200, body: { card: CARD } } };
    const args = [
      'eval',
      'task',
      'draft',
      'INT-2026-0006',
      '--project',
      'shop',
      '--task',
      'tax-rule',
    ];
    const target = path.join(dir, '.sdlc', 'eval-tasks', 'tax-rule.yaml');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'mine\n');
    const h = await harness({ cwd: dir, routes });
    expect(await h.run(args)).toBe(EXIT.failed);
    expect(await readFile(target, 'utf8')).toBe('mine\n');
    expect(h.err.join('\n')).toContain('--force');
    await rm(target);
    await writeFile(path.join(dir, 'elsewhere'), 'other\n');
    await symlink(path.join(dir, 'elsewhere'), target);
    const forced = await harness({ cwd: dir, routes });
    expect(await forced.run([...args, '--force'])).toBe(EXIT.failed);
    expect(await readFile(path.join(dir, 'elsewhere'), 'utf8')).toBe('other\n');
  });

  it('refuses outside a repository and with bad arguments, without calling the API', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'sdlc-no-repo-'));
    dirs.push(outside);
    const h = await harness({
      cwd: outside,
      routes: { [DRAFT]: { status: 200, body: { card: CARD } } },
    });
    const args = [
      'eval',
      'task',
      'draft',
      'INT-2026-0006',
      '--project',
      'shop',
      '--task',
      'tax-rule',
    ];
    expect(await h.run(args)).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain(t('cli.eval.task.no_repository'));
    expect(
      await h.run(['eval', 'task', 'draft', 'INT-1', '--project', 'shop', '--task', 'x']),
    ).toBe(EXIT.usage);
    expect(h.requests).toHaveLength(0);
  });
});

describe('sdlc eval task register|list|approve|reject (AC1)', () => {
  it('registers a card and prints the task', async () => {
    const h = await harness({
      routes: {
        'POST /v1/projects/shop/eval-tasks': {
          status: 200,
          body: { outcome: 'created', task: { ...TASK, status: 'registered' } },
        },
      },
    });
    expect(await h.run(['eval', 'task', 'register', 'tax-rule', '--project', 'shop'])).toBe(
      EXIT.ok,
    );
    expect(h.requests[0]!.body).toEqual({ task: 'tax-rule' });
    expect(h.out.join('\n')).toContain(t('cli.eval.task.created', { task: 'tax-rule' }));
  });

  it('lists the tasks with the card SHA-256 to review', async () => {
    const h = await harness({
      routes: { 'GET /v1/projects/shop/eval-tasks': { status: 200, body: { tasks: [TASK] } } },
    });
    expect(await h.run(['eval', 'task', 'list', '--project', 'shop'])).toBe(EXIT.ok);
    expect(h.out.join('\n')).toContain(TASK.card_sha256);
    const json = await harness({
      routes: { 'GET /v1/projects/shop/eval-tasks': { status: 200, body: { tasks: [TASK] } } },
    });
    expect(await json.run(['eval', 'task', 'list', '--project', 'shop', '--json'])).toBe(EXIT.ok);
    expect(JSON.parse(json.out.join('\n'))).toEqual({ tasks: [TASK] });
  });

  it('approves and rejects with the card SHA-256; a reason is a code', async () => {
    const h = await harness({
      routes: {
        [`POST /v1/eval-tasks/${TASK.id}/approve`]: {
          status: 200,
          body: { task: { ...TASK, status: 'approved' } },
        },
        [`POST /v1/eval-tasks/${TASK.id}/reject`]: {
          status: 200,
          body: { task: { ...TASK, status: 'rejected' } },
        },
      },
    });
    expect(await h.run(['eval', 'task', 'approve', TASK.id, '--card', TASK.card_sha256])).toBe(
      EXIT.ok,
    );
    expect(h.requests[0]!.body).toEqual({ card_sha256: TASK.card_sha256 });
    expect(
      await h.run([
        'eval',
        'task',
        'reject',
        TASK.id,
        '--card',
        TASK.card_sha256,
        '--reason',
        'tests_weak',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[1]!.body).toEqual({ card_sha256: TASK.card_sha256, reason: 'tests_weak' });
    expect(h.out.join('\n')).toContain(t('cli.eval.task.rejected', { task: 'tax-rule' }));
    // No card, a free-text reason, or a reason on approve: usage, no request.
    expect(await h.run(['eval', 'task', 'approve', TASK.id])).toBe(EXIT.usage);
    expect(
      await h.run([
        'eval',
        'task',
        'reject',
        TASK.id,
        '--card',
        TASK.card_sha256,
        '--reason',
        'no',
      ]),
    ).toBe(EXIT.usage);
    expect(
      await h.run([
        'eval',
        'task',
        'approve',
        TASK.id,
        '--card',
        TASK.card_sha256,
        '--reason',
        'other',
      ]),
    ).toBe(EXIT.usage);
    expect(h.requests).toHaveLength(2);
  });

  it('prints the usage for an unknown subcommand', async () => {
    const h = await harness();
    expect(await h.run(['eval', 'task'])).toBe(EXIT.usage);
    expect(h.err.join('\n')).toContain('sdlc eval task draft');
  });
});
