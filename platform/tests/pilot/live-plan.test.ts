// E07 (Harry, plan answer 2): the plan file the owner merges on the real pilot for the live
// G1 → G8 test. It must pass the submission rules (B09), allow `docs/live-test/**` only, so a run
// that a person merges never changes the application code, and carry the stub model's `[stub:live]`
// script, which writes inside that folder only.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePlanFile } from '../../packages/core/src/plans/index.js';
import { repoRoot } from '../workspace/helpers.js';

const PILOT = path.join(repoRoot(), 'platform/tests/integration/pilot');
const plan = fs.readFileSync(path.join(PILOT, 'fixtures/live-plan.yaml'), 'utf8');
const stubModel = fs.readFileSync(
  path.join(repoRoot(), 'platform/tests/integration/agent/stub-model.mjs'),
  'utf8',
);

describe('E07: the live test plan file', () => {
  it('passes the submission rules with docs/live-test/** as its only path pattern', () => {
    const code = /intent_id: (INT-\d{4}-0001)/.exec(plan)?.[1];
    expect(code).toBeDefined();
    expect(parsePlanFile(plan, code!)).toEqual({
      ok: true,
      plan: {
        plannedFiles: ['docs/live-test/**'],
        allowedTools: ['file_editor', 'terminal'],
        changeFlags: [],
      },
    });
  });

  it('runs the [stub:live] script, which writes under docs/live-test/ only', () => {
    expect(plan).toContain('[stub:live]');
    expect(stubModel).toMatch(/const LIVE_FILE = '\/workspace\/docs\/live-test\/[A-Z]+\.md';/);
    expect(plan).not.toMatch(/apps\//);
  });
});
