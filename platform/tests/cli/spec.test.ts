// `sdlc spec link|list` (B08 AC1, ADR-M39 §2.2) against a mocked API: the request carries the
// path and, when given, the commit; the content is never sent (the platform reads it from the Git
// host); refusals come back with their code; the token never reaches the output.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { linkedSpecBody, specListBody } from './fixtures.js';
import { apiError, TOKEN, useHarness } from './harness.js';

const harness = useHarness();
const PATH = '/v1/intents/INT-2026-0007/specs';
const COMMIT = 'd'.repeat(40);

describe('sdlc spec', () => {
  it('links a spec by path and commit', async () => {
    const h = await harness({
      routes: { [`POST ${PATH}`]: { status: 201, body: linkedSpecBody() } },
    });
    expect(
      await h.run([
        'spec',
        'link',
        'int-2026-0007',
        '--path',
        'docs/specs/T07 cancel.md',
        '--commit',
        COMMIT,
        '--tool',
        'spec-kit',
      ]),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      path: 'docs/specs/T07 cancel.md',
      commit_sha: COMMIT,
      source_tool: 'spec-kit',
    });
    expect(h.out).toEqual([
      t('cli.spec.linked', {
        intent: 'INT-2026-0007',
        version: 2,
        path: 'docs/specs/T07 cancel.md',
        commit: COMMIT,
        sha256: 'a'.repeat(64),
        tool: 'spec-kit',
        structure: 'spec_kit',
        criteria: '4',
      }),
    ]);
  });

  it('S01: says when the linked spec has no acceptance criteria, and shows the count', async () => {
    const body = { ...linkedSpecBody(), structure: 'none', acceptance_criteria: 0 };
    const h = await harness({ routes: { [`POST ${PATH}`]: { status: 201, body } } });
    expect(await h.run(['spec', 'link', 'INT-2026-0007', '--path', 'a.md'])).toBe(EXIT.ok);
    expect(h.out[0]).toContain('structure none, 0 acceptance criteria');
    expect(h.out[1]).toBe(t('cli.spec.no_criteria', { intent: 'INT-2026-0007' }));
    // A spec linked before S01 shows `-`.
    const old = {
      ...linkedSpecBody(),
      source_tool: null,
      structure: null,
      acceptance_criteria: null,
    };
    const h2 = await harness({ routes: { [`POST ${PATH}`]: { status: 201, body: old } } });
    expect(await h2.run(['spec', 'link', 'INT-2026-0007', '--path', 'a.md'])).toBe(EXIT.ok);
    expect(h2.out[0]).toContain('Tool -, structure -, - acceptance criteria');
    expect(h2.out[1]).toBe(t('cli.spec.no_criteria', { intent: 'INT-2026-0007' }));
  });

  it('links without a commit (the head of the default branch), with --json', async () => {
    const h = await harness({
      routes: { [`POST ${PATH}`]: { status: 201, body: linkedSpecBody() } },
    });
    expect(
      await h.run(['spec', 'link', 'INT-2026-0007', '--path', 'docs/specs/T07.md', '--json']),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ path: 'docs/specs/T07.md' });
    expect(JSON.parse(h.out.join('\n'))).toEqual(linkedSpecBody());
  });

  it('lists the versions, or says there is none', async () => {
    const h = await harness({ routes: { [`GET ${PATH}`]: { status: 200, body: specListBody() } } });
    expect(await h.run(['spec', 'list', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(h.out).toHaveLength(2);
    expect(h.out[0]).toContain('v1');
    expect(h.out[0]).toContain('criteria 4');
    const empty = await harness({
      routes: { [`GET ${PATH}`]: { status: 200, body: specListBody(true) } },
    });
    expect(await empty.run(['spec', 'list', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(empty.out).toEqual([t('cli.spec.none', { intent: 'INT-2026-0007' })]);
  });

  it('reports a refusal of the API (exit 1)', async () => {
    const h = await harness({
      routes: { [`POST ${PATH}`]: apiError(409, 'spec_not_on_default_branch') },
    });
    expect(
      await h.run(['spec', 'link', 'INT-2026-0007', '--path', 'a.md', '--commit', COMMIT]),
    ).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain('spec_not_on_default_branch');
    expect([...h.out, ...h.err].join('\n')).not.toContain(TOKEN);
  });

  it.each([
    [['spec']],
    [['spec', 'link', 'INT-2026-0007']],
    [['spec', 'link', 'not-an-intent', '--path', 'a.md']],
    [['spec', 'link', 'INT-2026-0007', '--path', 'a.md', '--commit', 'main']],
    [['spec', 'link', 'INT-2026-0007', '--path', 'a.md', '--tool', 'word']],
    [['spec', 'list']],
    [['spec', 'remove', 'INT-2026-0007']],
  ])('usage error for %j (exit 2, no request)', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.spec.usage')]);
    expect(h.requests).toEqual([]);
  });
});
