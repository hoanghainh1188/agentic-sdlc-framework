// `sdlc plan draft` (S02 AC1–AC4, ADR-M62): the draft is written on this machine only. No API call
// and no Git command; the default file is `.sdlc/plans/<INT>.yaml` in the nearest folder that holds
// `.git`; an existing file is replaced only with `--force`; refusals use the catalog (exit 1).
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DRAFT_CHECK_VALUES } from '../../packages/core/src/plans/index.js';
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { useHarness, type Harness } from './harness.js';

const harness = useHarness();
const FIXTURES = join(__dirname, '..', 'plans', 'fixtures');
const SPEC_KIT = join(FIXTURES, 'spec-kit-tasks-filled.md');
const BMAD = join(FIXTURES, 'bmad-story-tasks.md');

/** A repository with `.git` and a sub-folder to run from. */
async function repo(h: Harness): Promise<{ root: string; sub: string }> {
  const root = join(h.home, 'repo');
  const sub = join(root, 'apps', 'api');
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(sub, { recursive: true });
  return { root, sub };
}

async function inRepo(): Promise<{ h: Harness; root: string; sub: string }> {
  const base = await harness({ loggedIn: false });
  const { root, sub } = await repo(base);
  const h = await harness({ loggedIn: false, cwd: sub });
  // The first harness only lends its throw-away folder (removed after the test).
  return { h, root, sub };
}

describe('sdlc plan draft', () => {
  it('writes .sdlc/plans/<INT>.yaml at the repository root, from a sub-folder, with no request', async () => {
    const { h, root } = await inRepo();
    expect(
      await h.run(['plan', 'draft', 'int-2026-0007', '--from', SPEC_KIT, '--tool', 'spec-kit']),
    ).toBe(EXIT.ok);
    const file = join(root, '.sdlc', 'plans', 'INT-2026-0007.yaml');
    const yaml = await readFile(file, 'utf8');
    expect(yaml).toContain('intent_id: "INT-2026-0007"');
    expect(yaml).toContain('allowed_paths: null');
    expect(yaml).not.toContain(DRAFT_CHECK_VALUES.allowedPaths[0]);
    expect(h.requests).toEqual([]);
    expect(h.out[0]).toBe(
      t('cli.plan.draft.written', {
        intent: 'INT-2026-0007',
        path: '../../.sdlc/plans/INT-2026-0007.yaml',
        tasks: 6,
        tool: 'spec-kit',
      }),
    );
    expect(h.out).toContain('  - tasks[5].tools');
    expect(h.out).toContain('  - plan.change_flags');
    expect(h.out.at(-1)).toBe(t('cli.plan.draft.next', { intent: 'INT-2026-0007' }));
    expect(h.err).toEqual([]);
  });

  it('never overwrites an existing plan file without --force', async () => {
    const { h, root } = await inRepo();
    const file = join(root, '.sdlc', 'plans', 'INT-2026-0007.yaml');
    await mkdir(join(root, '.sdlc', 'plans'), { recursive: true });
    await writeFile(file, 'kept\n');
    const args = ['plan', 'draft', 'INT-2026-0007', '--from', BMAD, '--tool', 'bmad'];
    expect(await h.run(args)).toBe(EXIT.failed);
    expect(await readFile(file, 'utf8')).toBe('kept\n');
    expect(h.err[0]).toContain(
      t('plan.draft.refusal.output_exists', { path: '../../.sdlc/plans/INT-2026-0007.yaml' }),
    );
    expect(await h.run([...args, '--force'])).toBe(EXIT.ok);
    expect(await readFile(file, 'utf8')).toContain('id: "Task1"');
  });

  it('never writes through a symbolic link, also with --force', async () => {
    const { h, root } = await inRepo();
    const victim = join(root, 'victim.txt');
    await writeFile(victim, 'kept\n');
    await mkdir(join(root, '.sdlc', 'plans'), { recursive: true });
    await symlink(victim, join(root, '.sdlc', 'plans', 'INT-2026-0007.yaml'));
    const args = ['plan', 'draft', 'INT-2026-0007', '--from', BMAD, '--tool', 'bmad', '--force'];
    expect(await h.run(args)).toBe(EXIT.failed);
    expect(await readFile(victim, 'utf8')).toBe('kept\n');
    expect(h.err[0]).toContain('ELOOP');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO as the source without waiting',
    async () => {
      const { h, sub } = await inRepo();
      const fifo = join(sub, 'tasks.md');
      execFileSync('mkfifo', [fifo]);
      expect(
        await h.run(['plan', 'draft', 'INT-2026-0007', '--from', fifo, '--tool', 'spec-kit']),
      ).toBe(EXIT.failed);
      expect(h.err[0]).toContain(t('plan.draft.refusal.input_not_a_file'));
    },
  );

  it('writes to --output, with --json', async () => {
    const h = await harness({ loggedIn: false, cwd: '/' });
    const output = join(h.home, 'draft.yaml');
    expect(
      await h.run([
        'plan',
        'draft',
        'INT-2026-0007',
        '--from',
        BMAD,
        '--tool',
        'bmad',
        '--output',
        output,
        '--json',
      ]),
    ).toBe(EXIT.ok);
    expect(JSON.parse(h.out.join('\n'))).toEqual({
      intent: 'INT-2026-0007',
      path: output,
      tool: 'bmad',
      tasks: 2,
      grouped: false,
      unfilled: [
        'plan.change_flags',
        'tasks[0].allowed_paths',
        'tasks[0].tools',
        'tasks[1].allowed_paths',
        'tasks[1].tools',
      ],
    });
    expect((await stat(output)).isFile()).toBe(true);
  });

  it('refuses without .git and without --output', async () => {
    const h = await harness({ loggedIn: false });
    const ctxCwd = join(h.home, 'no-repo');
    await mkdir(ctxCwd);
    const run = await harness({ loggedIn: false, cwd: ctxCwd });
    // The throw-away home is under the system's temp folder, which holds no `.git`.
    expect(
      await run.run(['plan', 'draft', 'INT-2026-0007', '--from', BMAD, '--tool', 'bmad']),
    ).toBe(EXIT.failed);
    expect(run.err).toEqual([
      t('cli.plan.draft.refused', { reason: t('plan.draft.refusal.no_repository') }),
    ]);
  });

  it.each([
    ['a missing file', 'missing.md', 'input_missing'],
    ['a folder', '.', 'input_not_a_file'],
  ])('refuses %s as the source', async (_, from, refusal) => {
    const { h } = await inRepo();
    expect(
      await h.run(['plan', 'draft', 'INT-2026-0007', '--from', from, '--tool', 'spec-kit']),
    ).toBe(EXIT.failed);
    expect(h.err[0]).toContain(
      t(`plan.draft.refusal.${refusal}` as 'plan.draft.refusal.input_missing'),
    );
  });

  it('refuses a source that is too large or not UTF-8', async () => {
    const { h, sub } = await inRepo();
    await writeFile(join(sub, 'big.md'), 'x'.repeat(256 * 1024 + 1));
    await writeFile(join(sub, 'latin1.md'), Buffer.from([0x2d, 0x20, 0xe9, 0x0a]));
    expect(
      await h.run(['plan', 'draft', 'INT-2026-0007', '--from', 'big.md', '--tool', 'bmad']),
    ).toBe(EXIT.failed);
    expect(
      await h.run(['plan', 'draft', 'INT-2026-0007', '--from', 'latin1.md', '--tool', 'bmad']),
    ).toBe(EXIT.failed);
    expect(h.err[0]).toContain(t('plan.draft.refusal.input_too_large'));
    expect(h.err[1]).toContain(t('plan.draft.refusal.input_not_utf8'));
  });

  it('refuses a BMAD epics file with the catalog reason (exit 1)', async () => {
    const { h, root } = await inRepo();
    const epics = join(__dirname, '..', 'specs', 'fixtures', 'bmad-epics-filled.md');
    expect(await h.run(['plan', 'draft', 'INT-2026-0007', '--from', epics, '--tool', 'bmad'])).toBe(
      EXIT.failed,
    );
    expect(h.err).toEqual([
      t('cli.plan.draft.refused', { reason: t('plan.draft.refusal.epics_file') }),
    ]);
    await expect(stat(join(root, '.sdlc'))).rejects.toThrow();
  });

  it.each([
    [['plan', 'draft', 'INT-2026-0007', '--tool', 'bmad']],
    [['plan', 'draft', 'INT-2026-0007', '--from', 'x.md']],
    [['plan', 'draft', 'INT-2026-0007', '--from', 'x.md', '--tool', 'openspec']],
    [['plan', 'draft', '00000000-0000-4000-8000-000000000000', '--from', 'x.md', '--tool', 'bmad']],
    [['plan', 'draft', 'INT-2026-0007', '--from', 'x.md', '--tool', 'bmad', '--output', '']],
  ])('usage error for %j (exit 2)', async (argv) => {
    const h = await harness({ loggedIn: false });
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.plan.usage')]);
  });
});
