// `sdlc intent create … --spec` (D-08 U03) against a mocked API: the intent is created, then the
// spec is linked with the existing call (no new endpoint); a refused link keeps the intent and
// says how to link again; a refused create links nothing; bad spec options make no call at all.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { intentBody, linkedSpecBody } from './fixtures.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();

const COMMIT = 'd'.repeat(40);
const SPECS = 'POST /v1/intents/INT-2026-0007/specs';
const CREATE = [
  'intent',
  'create',
  '--project',
  'pilot',
  '--title',
  'Add Japanese labels',
  '--risk',
  'low',
  '--data-class',
  'internal',
];
const WITH_SPEC = [...CREATE, '--spec', 'docs/specs/T01.md'];

const created = () =>
  t('cli.intent.created', {
    code: 'INT-2026-0007',
    project: 'pilot',
    status: 'in_gate',
    risk: 'low',
    data_class: 'internal',
    max_autonomy: 'L2',
    budget: '2.500000',
  });

describe('sdlc intent create --spec (U03)', () => {
  it('creates the intent, then links the spec with the same request as `sdlc spec link`', async () => {
    const h = await harness({
      routes: {
        'POST /v1/intents': { status: 201, body: intentBody() },
        [SPECS]: { status: 201, body: linkedSpecBody() },
      },
    });
    expect(await h.run([...WITH_SPEC, '--spec-commit', COMMIT, '--spec-tool', 'spec-kit'])).toBe(
      EXIT.ok,
    );
    expect(h.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      'POST /v1/intents',
      SPECS,
    ]);
    // The create body is unchanged; the spec options go to the link only.
    expect(h.requests[0]?.body).not.toHaveProperty('spec');
    expect(h.requests[1]?.body).toEqual({
      path: 'docs/specs/T01.md',
      commit_sha: COMMIT,
      source_tool: 'spec-kit',
    });
    expect(h.out[0]).toBe(created());
    expect(h.out[1]).toBe(
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
    );
    expect(h.out).toHaveLength(2);
  });

  it('warns when the linked spec has no acceptance criteria (S01)', async () => {
    const h = await harness({
      routes: {
        'POST /v1/intents': { status: 201, body: intentBody() },
        [SPECS]: {
          status: 201,
          body: { ...linkedSpecBody(), structure: 'none', acceptance_criteria: 0 },
        },
      },
    });
    expect(await h.run(WITH_SPEC)).toBe(EXIT.ok);
    expect(h.requests[1]?.body).toEqual({ path: 'docs/specs/T01.md' });
    expect(h.out[2]).toBe(t('cli.spec.no_criteria', { intent: 'INT-2026-0007' }));
  });

  it('keeps the intent when the link is refused: names it, says how to link again, exits 1', async () => {
    const h = await harness({
      routes: {
        'POST /v1/intents': { status: 201, body: intentBody() },
        [SPECS]: apiError(409, 'spec_not_on_default_branch'),
      },
    });
    expect(await h.run(WITH_SPEC)).toBe(EXIT.failed);
    expect(h.out).toEqual([created()]);
    expect(h.err.at(-1)).toBe(
      t('cli.intent.spec_link_refused', { code: 'INT-2026-0007', path: 'docs/specs/T01.md' }),
    );
    expect(h.err.at(-1)).toContain('sdlc spec link INT-2026-0007 --path docs/specs/T01.md');
  });

  it('a refused create links nothing', async () => {
    const h = await harness({ routes: { 'POST /v1/intents': apiError(403, 'forbidden') } });
    expect(await h.run(WITH_SPEC)).toBe(EXIT.failed);
    expect(h.requests.map((r) => r.url.pathname)).toEqual(['/v1/intents']);
    expect(h.out).toEqual([]);
  });

  it('--json: the intent, the spec and no error', async () => {
    const h = await harness({
      routes: {
        'POST /v1/intents': { status: 201, body: intentBody() },
        [SPECS]: { status: 201, body: linkedSpecBody() },
      },
    });
    expect(await h.run([...WITH_SPEC, '--json'])).toBe(EXIT.ok);
    expect(JSON.parse(h.out.join('\n'))).toEqual({
      intent: intentBody(),
      spec: linkedSpecBody(),
      spec_error: null,
    });
  });

  it('--json: a refused link gives the intent, no spec and the error, exit 1', async () => {
    const h = await harness({
      routes: {
        'POST /v1/intents': { status: 201, body: intentBody() },
        [SPECS]: apiError(403, 'forbidden'),
      },
    });
    expect(await h.run([...WITH_SPEC, '--json'])).toBe(EXIT.failed);
    expect(JSON.parse(h.out.join('\n'))).toEqual({
      intent: intentBody(),
      spec: null,
      spec_error: { code: 'forbidden', message: 'server text for forbidden' },
    });
  });

  it('--json without --spec keeps the plain intent body', async () => {
    const h = await harness({
      routes: { 'POST /v1/intents': { status: 201, body: intentBody() } },
    });
    expect(await h.run([...CREATE, '--json'])).toBe(EXIT.ok);
    expect(JSON.parse(h.out.join('\n'))).toEqual(intentBody());
  });

  it.each([
    [[...CREATE, '--spec-commit', COMMIT]],
    [[...CREATE, '--spec-tool', 'bmad']],
    [[...WITH_SPEC, '--spec-commit', 'abc']],
    [[...WITH_SPEC, '--spec-tool', 'word']],
    [[...CREATE, '--spec', '']],
  ])('prints the usage and makes no call for %j', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.intent.usage')]);
    expect(h.requests).toEqual([]);
  });
});
