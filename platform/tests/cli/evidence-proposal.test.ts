// `sdlc evidence proposal` (D-08 C13, ADR-M64 §2.1) against a mocked API: the latest run with a
// proposal by default, or the named run; the bytes checked against the SHA-256 before they are
// saved (mode 600, never printed, never over a file without --force); refusals and the usage.
import { lstat, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { proposalBody, RUN_ID, runListBody } from './fixtures.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();
const RUNS = 'GET /v1/intents/INT-2026-0007/runs';
const PROPOSAL = `GET /v1/intents/INT-2026-0007/runs/${RUN_ID}/proposal`;
/** Not UTF-8 (a Shift_JIS line): the bytes must reach the file unchanged. */
const PATCH = Buffer.concat([
  Buffer.from('diff --git a/x b/x\n+'),
  Buffer.from([0x93, 0xfa, 0x0a]),
]);

describe('sdlc evidence proposal', () => {
  it('saves the latest run with a proposal, byte for byte, with mode 600, and prints no content', async () => {
    const h = await harness({
      routes: {
        [RUNS]: { status: 200, body: runListBody({ status: 'succeeded_proposal_only' }) },
        [PROPOSAL]: { status: 200, body: proposalBody(PATCH) },
      },
    });
    const file = join(h.home, 'run.patch');
    expect(await h.run(['evidence', 'proposal', 'int-2026-0007', '--output', file])).toBe(EXIT.ok);
    expect(h.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([RUNS, PROPOSAL]);
    expect((await readFile(file)).equals(PATCH)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain(file);
    expect(h.out.join('\n')).not.toContain('diff --git');
  });

  it('--run names the run; --json gives the saved file and the hash, never the content', async () => {
    const h = await harness({ routes: { [PROPOSAL]: { status: 200, body: proposalBody(PATCH) } } });
    const file = join(h.home, 'named.patch');
    expect(
      await h.run([
        'evidence',
        'proposal',
        'INT-2026-0007',
        '--run',
        RUN_ID.toUpperCase(),
        '--output',
        file,
        '--json',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests.map((r) => r.url.pathname)).toEqual([PROPOSAL.slice(4)]);
    const out = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(out).toMatchObject({ intent: 'INT-2026-0007', run_id: RUN_ID, path: file });
    expect(out).not.toHaveProperty('content_base64');
  });

  it('refuses bytes that do not match the SHA-256, and saves nothing', async () => {
    const h = await harness({
      routes: { [PROPOSAL]: { status: 200, body: proposalBody(PATCH, 'f'.repeat(64)) } },
    });
    const file = join(h.home, 'bad.patch');
    expect(
      await h.run(['evidence', 'proposal', 'INT-2026-0007', '--run', RUN_ID, '--output', file]),
    ).toBe(EXIT.failed);
    expect(h.err).toEqual([t('cli.evidence.hash_mismatch', { name: 'proposal' })]);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never replaces a file without --force; with it, the file is replaced', async () => {
    const h = await harness({ routes: { [PROPOSAL]: { status: 200, body: proposalBody(PATCH) } } });
    const file = join(h.home, 'exists.patch');
    await writeFile(file, 'old');
    const argv = ['evidence', 'proposal', 'INT-2026-0007', '--run', RUN_ID, '--output', file];
    expect(await h.run(argv)).toBe(EXIT.failed);
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await h.run([...argv, '--force'])).toBe(EXIT.ok);
    expect((await readFile(file)).equals(PATCH)).toBe(true);
  });

  it('downloads a patch larger than the default 4 MiB answer cap (up to PROPOSAL_MAX_BYTES)', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x2b);
    const h = await harness({ routes: { [PROPOSAL]: { status: 200, body: proposalBody(big) } } });
    const file = join(h.home, 'big.patch');
    expect(
      await h.run(['evidence', 'proposal', 'INT-2026-0007', '--run', RUN_ID, '--output', file]),
    ).toBe(EXIT.ok);
    expect((await readFile(file)).equals(big)).toBe(true);
  });

  it('--force replaces a link with a new file and never writes through it', async () => {
    const h = await harness({ routes: { [PROPOSAL]: { status: 200, body: proposalBody(PATCH) } } });
    const elsewhere = join(h.home, 'elsewhere.txt');
    await writeFile(elsewhere, 'keep me');
    const file = join(h.home, 'link.patch');
    await symlink(elsewhere, file);
    const argv = ['evidence', 'proposal', 'INT-2026-0007', '--run', RUN_ID, '--output', file];
    expect(await h.run(argv)).toBe(EXIT.failed);
    expect(await h.run([...argv, '--force'])).toBe(EXIT.ok);
    expect(await readFile(elsewhere, 'utf8')).toBe('keep me');
    expect((await lstat(file)).isSymbolicLink()).toBe(false);
    expect((await readFile(file)).equals(PATCH)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('says when no run has a proposal (exit 1), and shows the API refusal', async () => {
    const none = await harness({ routes: { [RUNS]: { status: 200, body: runListBody() } } });
    expect(await none.run(['evidence', 'proposal', 'INT-2026-0007', '--output', 'x.patch'])).toBe(
      EXIT.failed,
    );
    expect(none.err).toEqual([t('cli.evidence.no_proposal', { intent: 'INT-2026-0007' })]);

    const purged = await harness({ routes: { [PROPOSAL]: apiError(410, 'proposal_purged') } });
    expect(
      await purged.run([
        'evidence',
        'proposal',
        'INT-2026-0007',
        '--run',
        RUN_ID,
        '--output',
        'x.patch',
      ]),
    ).toBe(EXIT.failed);
    expect(purged.err[0]).toContain('proposal_purged');
  });

  it.each([
    [['evidence', 'proposal', 'INT-2026-0007']],
    [['evidence', 'proposal', 'INT-2026-0007', '--output', '']],
    [['evidence', 'proposal', 'INT-2026-0007', '--output', 'x', '--run', 'not-a-uuid']],
    [['evidence', 'proposal', '--output', 'x']],
  ])('prints the usage and makes no call for %j', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.evidence.usage')]);
    expect(h.requests).toEqual([]);
  });
});
