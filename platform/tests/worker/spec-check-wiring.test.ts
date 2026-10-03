// B08 (ADR-M39 §2.4): the worker always wires the spec re-check at G2–G4 into the intent step, and
// the activity passes it on. Without it the step would not check the spec (the tests of other
// gates rely on that), so the wiring is checked statically here and live by `pnpm test:workflow`.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createIntentActivities } from '../../apps/worker/src/activities/intent-activities.js';

const main = readFileSync(path.resolve(__dirname, '../../apps/worker/src/main.ts'), 'utf8');

describe('worker: the spec check is wired', () => {
  it('main.ts passes the GitHub adapter as `specs` to the intent activities, unconditionally', () => {
    const call = main.slice(main.indexOf('createIntentActivities({'));
    const args = call.slice(0, call.indexOf('}),'));
    expect(args).toMatch(/^\s*specs: \{ gitHost \},$/m);
  });

  it('the activity passes `specs` to the step', async () => {
    const gitHost = {
      getBranchHead: () => Promise.reject(new Error('reached the Git host')),
      getFileAtCommit: () => Promise.reject(new Error('unused')),
    };
    const intent = { id: 'i', status: 'in_gate', current_gate: 'G3', project_id: 'p' };
    const scope = {
      intents: { getById: () => Promise.resolve(intent) },
      projects: {
        getById: () => Promise.resolve({ repo_full_name: 'acme/shop', default_branch: 'main' }),
      },
    };
    const activities = createIntentActivities({
      db: { forTenant: () => scope } as never,
      registry: {} as never,
      specs: { gitHost },
    });
    await expect(
      activities.stepIntent({ tenantId: '11111111-1111-4111-8111-111111111111', intentId: 'i' }),
    ).rejects.toThrow('reached the Git host');
  });
});
