// `sdlc eval …` (task L05, ADR-M82 §2.7) against a mocked API: the paths and bodies it sends, the
// plan file (JSON, at most 64 KB, never printed back), Run now, and refusals with their code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT } from '../../apps/cli/src/index.js';
import { evalPlanBody, evaluationBody } from './fixtures.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();
const PLAN = '88888888-8888-4888-8888-888888888888';

function planFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-cli-'));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, content);
  return file;
}

describe('sdlc eval', () => {
  it('creates a plan from the file and prints its code', async () => {
    const h = await harness({
      routes: { 'POST /v1/projects/shop/eval-plans': { status: 201, body: evalPlanBody() } },
    });
    const file = planFile(JSON.stringify({ code: 'weekly-models', runs_per_task: 2 }));
    expect(await h.run(['eval', 'plan', 'create', '--project', 'shop', '--file', file])).toBe(
      EXIT.ok,
    );
    expect(h.requests[0]!.body).toEqual({ code: 'weekly-models', runs_per_task: 2 });
    expect(h.out[0]).toBe(t('cli.eval.plan.created', { id: PLAN, code: 'weekly-models' }));
  });

  it('a change sends the expected version', async () => {
    const h = await harness({
      routes: { [`POST /v1/eval-plans/${PLAN}/versions`]: { status: 201, body: evalPlanBody() } },
    });
    const file = planFile('{"runs_per_task": 3}');
    expect(
      await h.run(['eval', 'plan', 'change', PLAN, '--file', file, '--expected-version', '2']),
    ).toBe(EXIT.ok);
    expect(h.requests[0]!.body).toEqual({ runs_per_task: 3, expected_version: 2 });
  });

  it('refuses a file that is not a JSON object, or too large, without calling the API', async () => {
    const h = await harness({ routes: {} });
    for (const content of ['[1]', 'not json', 'x'.repeat(70 * 1024)]) {
      expect(
        await h.run(['eval', 'plan', 'create', '--project', 'shop', '--file', planFile(content)]),
      ).toBe(EXIT.usage);
    }
    expect(h.requests).toEqual([]);
    expect(h.err.at(-1)).toBe(t('cli.eval.file_unreadable'));
  });

  it('Run now posts to the plan and says the worker starts it', async () => {
    const h = await harness({
      routes: { [`POST /v1/eval-plans/${PLAN}/runs`]: { status: 202, body: evalPlanBody() } },
    });
    expect(await h.run(['eval', 'run', PLAN])).toBe(EXIT.ok);
    expect(h.out[0]).toBe(t('cli.eval.run.requested', { code: 'weekly-models' }));
  });

  it('shows an evaluation with its runs and spend', async () => {
    const h = await harness({
      routes: { 'GET /v1/evaluations/EVAL-2026-0001': { status: 200, body: evaluationBody(true) } },
    });
    expect(await h.run(['eval', 'show', 'EVAL-2026-0001'])).toBe(EXIT.ok);
    expect(h.out[1]).toContain('0.42');
  });

  it('a refusal comes back with its code; bad arguments print the usage', async () => {
    const h = await harness({
      routes: {
        [`POST /v1/eval-plans/${PLAN}/runs`]: apiError(409, 'evaluation_conflict', {
          reason: 'evaluation_open',
        }),
      },
    });
    expect(await h.run(['eval', 'run', PLAN])).toBe(EXIT.failed);
    expect(await h.run(['eval', 'run', 'not-a-uuid'])).toBe(EXIT.usage);
    expect(await h.run(['eval', 'show', 'INT-2026-0001'])).toBe(EXIT.usage);
    expect(h.err.at(-1)).toBe(t('cli.eval.usage'));
  });
});
