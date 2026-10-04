// `sdlc evidence build|list|show|export` (E02 AC1–AC4, D-02 FR-40, FR-42, ADR-M48) against a
// mocked API: the right endpoints, a new version or an unchanged one, the latest version by
// default, the exported file checked against its SHA-256 before it is printed or saved, never an
// overwritten file, refusals with their code, and the usage.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { evidenceFileBody, evidencePackBody } from './fixtures.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();
const BASE = '/v1/intents/INT-2026-0007/evidence-packs';
const MD = '# Evidence Pack INT\\-2026\\-0007 (version 2)\n\n## Intent\n';

describe('sdlc evidence', () => {
  it('build: POST, and says whether a new version was made', async () => {
    const h = await harness({
      routes: {
        [`POST ${BASE}`]: { status: 201, body: { pack: evidencePackBody(), created: true } },
      },
    });
    expect(await h.run(['evidence', 'build', 'int-2026-0007'])).toBe(EXIT.ok);
    expect(h.requests[0]!.method).toBe('POST');
    expect(h.out[0]).toBe(t('cli.evidence.built', { intent: 'INT-2026-0007', version: 1 }));
    expect(h.out.join('\n')).toContain('b'.repeat(64));

    const same = await harness({
      routes: {
        [`POST ${BASE}`]: { status: 200, body: { pack: evidencePackBody(), created: false } },
      },
    });
    expect(await same.run(['evidence', 'build', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(same.out[0]).toBe(t('cli.evidence.unchanged', { intent: 'INT-2026-0007', version: 1 }));
  });

  it('list and show: every version; show without --version is the latest', async () => {
    const list = {
      status: 200,
      body: { intent: 'INT-2026-0007', packs: [evidencePackBody(1), evidencePackBody(2, true)] },
    };
    const h = await harness({ routes: { [`GET ${BASE}`]: list } });
    expect(await h.run(['evidence', 'list', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(h.out).toHaveLength(2);
    expect(h.out[1]).toContain('v2');
    expect(await h.run(['evidence', 'show', 'INT-2026-0007', '--json'])).toBe(EXIT.ok);
    expect(JSON.parse(h.out.slice(2).join('\n'))).toMatchObject({ pack: { version: 2 } });

    const one = await harness({
      routes: { [`GET ${BASE}/1`]: { status: 200, body: { pack: evidencePackBody(1) } } },
    });
    expect(await one.run(['evidence', 'show', 'INT-2026-0007', '--version', '1'])).toBe(EXIT.ok);
    expect(one.requests[0]!.url.pathname).toBe(`${BASE}/1`);
  });

  it('export: prints the Markdown after checking its SHA-256; --manifest reads the manifest', async () => {
    const h = await harness({
      routes: {
        [`GET ${BASE}`]: {
          status: 200,
          body: { intent: 'INT-2026-0007', packs: [evidencePackBody(1), evidencePackBody(2)] },
        },
        [`GET ${BASE}/2/markdown`]: { status: 200, body: evidenceFileBody(MD) },
        [`GET ${BASE}/1/manifest`]: { status: 200, body: evidenceFileBody('{"a":1}') },
      },
    });
    expect(await h.run(['evidence', 'export', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(h.out).toEqual(MD.slice(0, -1).split('\n'));
    expect(
      await h.run(['evidence', 'export', 'INT-2026-0007', '--version', '1', '--manifest']),
    ).toBe(EXIT.ok);
    expect(h.out.at(-1)).toBe('{"a":1}');
  });

  it('export --output: saves a new file (mode 600), never overwrites one', async () => {
    const h = await harness({
      routes: { [`GET ${BASE}/2/markdown`]: { status: 200, body: evidenceFileBody(MD) } },
    });
    const file = join(h.home, 'pack.md');
    const args = ['evidence', 'export', 'INT-2026-0007', '--version', '2', '--output', file];
    expect(await h.run(args)).toBe(EXIT.ok);
    expect(await readFile(file, 'utf8')).toBe(MD);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const other = join(h.home, 'taken.md');
    await writeFile(other, 'keep me');
    expect(await h.run([...args.slice(0, -1), other])).toBe(EXIT.failed);
    expect(await readFile(other, 'utf8')).toBe('keep me');
    expect(h.err.at(-1)).toContain('EEXIST');
  });

  it('export refuses a file whose SHA-256 is not the recorded one: nothing printed or saved', async () => {
    const h = await harness({
      routes: {
        [`GET ${BASE}/2/markdown`]: { status: 200, body: evidenceFileBody(MD, 'f'.repeat(64)) },
      },
    });
    const file = join(h.home, 'pack.md');
    expect(
      await h.run(['evidence', 'export', 'INT-2026-0007', '--version', '2', '--output', file]),
    ).toBe(EXIT.failed);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.err.at(-1)).toBe(t('cli.evidence.hash_mismatch', { name: 'pack.md' }));
    expect(h.out).toEqual([]);
  });

  it('refusals come back with their code (exit 1); a bad command line is a usage error', async () => {
    const h = await harness({
      routes: {
        [`POST ${BASE}`]: apiError(403, 'forbidden'),
        [`GET ${BASE}`]: apiError(404, 'intent_not_found'),
      },
    });
    expect(await h.run(['evidence', 'build', 'INT-2026-0007'])).toBe(EXIT.failed);
    expect(await h.run(['evidence', 'list', 'INT-2026-0007'])).toBe(EXIT.failed);
    for (const args of [
      ['evidence'],
      ['evidence', 'build'],
      ['evidence', 'build', 'not-an-intent'],
      ['evidence', 'show', 'INT-2026-0007', '--version', '0'],
      ['evidence', 'export', 'INT-2026-0007', '--json'],
      ['evidence', 'export', 'INT-2026-0007', '--output', ''],
    ]) {
      expect(await h.run(args), args.join(' ')).toBe(EXIT.usage);
    }
    expect(h.err.at(-1)).toBe(t('cli.evidence.usage'));
  });
});
