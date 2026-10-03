// `sdlc plan submit|list|show` (B09 AC2, ADR-M40 §2.3) against a mocked API: the request carries
// the commit only when given (the platform reads the file `.sdlc/plans/<INT>.yaml` from the Git
// host); refusals come back with their code and reason; the token never reaches the output.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { planListBody, submittedPlanBody } from './fixtures.js';
import { apiError, TOKEN, useHarness } from './harness.js';

const harness = useHarness();
const PATH = '/v1/intents/INT-2026-0007/plans';
const COMMIT = 'e'.repeat(40);

describe('sdlc plan', () => {
  it('submits the plan file at a commit', async () => {
    const h = await harness({
      routes: { [`POST ${PATH}`]: { status: 201, body: submittedPlanBody() } },
    });
    expect(await h.run(['plan', 'submit', 'int-2026-0007', '--commit', COMMIT])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ commit_sha: COMMIT });
    expect(h.out).toEqual([
      t('cli.plan.submitted', {
        intent: 'INT-2026-0007',
        version: 2,
        commit: COMMIT,
        sha256: 'a'.repeat(64),
        paths: 2,
        tools: 'file_editor,terminal',
        flags: 'migration',
      }),
    ]);
  });

  it('submits without a commit (the head of the default branch), with --json', async () => {
    const h = await harness({
      routes: { [`POST ${PATH}`]: { status: 201, body: submittedPlanBody() } },
    });
    expect(await h.run(['plan', 'submit', 'INT-2026-0007', '--json'])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({});
    expect(JSON.parse(h.out.join('\n'))).toEqual(submittedPlanBody());
  });

  it('lists the versions, shows the latest, or says there is none', async () => {
    const h = await harness({ routes: { [`GET ${PATH}`]: { status: 200, body: planListBody() } } });
    expect(await h.run(['plan', 'list', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(h.out).toHaveLength(2);
    expect(h.out[0]).toContain('v1');
    expect(h.out[0]).toContain(t('cli.plan.no_flags'));

    const show = await harness({
      routes: { [`GET ${PATH}`]: { status: 200, body: planListBody() } },
    });
    expect(await show.run(['plan', 'show', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(show.out.join('\n')).toContain('    apps/api/test/orders/**');
    expect(show.out.join('\n')).toContain('version 2');

    const empty = await harness({
      routes: { [`GET ${PATH}`]: { status: 200, body: planListBody(true) } },
    });
    expect(await empty.run(['plan', 'show', 'INT-2026-0007'])).toBe(EXIT.ok);
    expect(empty.out).toEqual([t('cli.plan.none', { intent: 'INT-2026-0007' })]);
  });

  it('reports a refused plan file with its reason (exit 1)', async () => {
    const h = await harness({
      routes: { [`POST ${PATH}`]: apiError(422, 'plan_invalid', { reason: 'pattern_too_broad' }) },
    });
    expect(await h.run(['plan', 'submit', 'INT-2026-0007'])).toBe(EXIT.failed);
    expect(h.err.join('\n')).toContain('plan_invalid');
    expect([...h.out, ...h.err].join('\n')).not.toContain(TOKEN);
  });

  it.each([
    [['plan']],
    [['plan', 'submit']],
    [['plan', 'submit', 'not-an-intent']],
    [['plan', 'submit', 'INT-2026-0007', '--commit', 'main']],
    [['plan', 'list']],
    [['plan', 'approve', 'INT-2026-0007']],
  ])('usage error for %j (exit 2, no request)', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.plan.usage')]);
    expect(h.requests).toEqual([]);
  });
});
