// U08 AC1–AC3 (design/ADR-M73 §2.1): the dashboard's model of the wave 2 actions, without a
// browser: a refusal of the spec link, the plan submission or the pack build in the catalog's
// words (the same keys as the API and the CLI), the commit field, and the CLI command that saves an
// L1 run's proposal (never a browser download, ADR-M64).
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  API_ERROR_KEYS,
  commitField,
  FORBIDDEN_KEYS,
  intakeErrorKey,
  PLAN_ERROR_KEYS,
  PLAN_REFUSAL_KEYS,
  proposalCommand,
  SPEC_ERROR_KEYS,
} from '../../apps/dashboard/src/model/intake.js';
import {
  PLAN_ERROR_MESSAGES,
  PLAN_REFUSAL_MESSAGES,
} from '../../packages/core/src/plans/errors.js';
import { SPEC_ERROR_MESSAGES } from '../../packages/core/src/specs/errors.js';
import { repoRoot } from '../workspace/helpers';

const catalog = JSON.parse(
  fs.readFileSync(path.join(repoRoot(), 'platform/packages/messages/src/locales/en.json'), 'utf8'),
) as Record<string, string>;
const dashboardSrc = path.join(repoRoot(), 'platform/apps/dashboard/src');

describe('U08: refusals in the catalog words (AC1, AC3)', () => {
  it('uses the same keys as core for spec and plan refusals', () => {
    // An unreadable spec and a refused plan file take a parameter: `intakeErrorKey` fills it.
    const without = (map: Record<string, string>, key: string) =>
      Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
    expect(SPEC_ERROR_KEYS).toEqual(without(SPEC_ERROR_MESSAGES, 'spec_unreadable'));
    expect(PLAN_ERROR_KEYS).toEqual(without(PLAN_ERROR_MESSAGES, 'plan_invalid'));
    expect(PLAN_REFUSAL_KEYS).toEqual(PLAN_REFUSAL_MESSAGES);
  });

  it('every key it can pick is in the catalog', () => {
    const keys = [
      ...Object.values(SPEC_ERROR_KEYS),
      ...Object.values(PLAN_ERROR_KEYS),
      ...Object.values(PLAN_REFUSAL_KEYS),
      ...Object.values(API_ERROR_KEYS),
      'spec.error.spec_unreadable',
      'plan.error.plan_invalid',
      ...Object.values(FORBIDDEN_KEYS),
    ];
    for (const key of keys) expect(catalog[key], key).toBeTypeOf('string');
  });

  it('a spec link: the reason names the sentence; an unreadable spec names its cause', () => {
    expect(
      intakeErrorKey({ code: 'spec_link_not_allowed', reason: 'link_not_allowed' }, 'spec'),
    ).toEqual({ key: 'spec.error.link_not_allowed' });
    expect(intakeErrorKey({ code: 'spec_invalid', reason: 'invalid_path' }, 'spec')).toEqual({
      key: 'spec.error.invalid_path',
    });
    expect(intakeErrorKey({ code: 'spec_invalid', reason: 'missing' }, 'spec')).toEqual({
      key: 'spec.error.spec_unreadable',
      params: { cause: 'missing' },
    });
    // A reason that is not a code is never shown.
    expect(intakeErrorKey({ code: 'spec_invalid', reason: '<b>x</b>' }, 'spec')).toEqual({
      key: 'spec.error.spec_unreadable',
      params: { cause: '-' },
    });
    expect(intakeErrorKey({ code: 'git_host_unavailable' }, 'spec')).toEqual({
      key: 'spec.error.git_host_unavailable',
    });
  });

  it('a plan: a refused file names why; other reasons their own sentence', () => {
    expect(intakeErrorKey({ code: 'plan_invalid', reason: 'yaml_invalid' }, 'plan')).toEqual({
      key: 'plan.error.plan_invalid',
      refusalKey: 'plan.refusal.yaml_invalid',
    });
    expect(
      intakeErrorKey({ code: 'plan_submit_not_allowed', reason: 'submit_not_allowed' }, 'plan'),
    ).toEqual({ key: 'plan.error.submit_not_allowed' });
    expect(intakeErrorKey({ code: 'git_host_unavailable' }, 'plan')).toEqual({
      key: 'plan.error.git_host_unavailable',
    });
  });

  it('a role refusal names the action and its access list; pack refusals use the API words', () => {
    for (const action of ['create', 'spec', 'plan', 'pack'] as const) {
      expect(intakeErrorKey({ code: 'forbidden' }, action)).toEqual({
        key: FORBIDDEN_KEYS[action],
      });
    }
    expect(intakeErrorKey({ code: 'evidence_pack_sealed' }, 'pack')).toEqual({
      key: 'api.error.evidence_pack_sealed',
    });
    expect(intakeErrorKey({ code: 'intent_not_found' }, 'plan')).toEqual({
      key: 'api.error.intent_not_found',
    });
    // Anything else goes to the shared action text (the code as a parameter).
    expect(intakeErrorKey({ code: 'rate_limited' }, 'pack')).toBeNull();
  });

  it('the dashboard bundles the spec, plan and API refusal keys', () => {
    const vite = fs.readFileSync(path.join(dashboardSrc, '../vite.config.ts'), 'utf8');
    for (const prefix of ['spec.error.', 'plan.error.', 'plan.refusal.', 'api.error.']) {
      expect(vite).toContain(`key.startsWith('${prefix}')`);
    }
  });
});

describe('U08: the plan commit and the L1 proposal (AC2)', () => {
  it('a commit is empty or 40 hex characters', () => {
    expect(commitField('')).toEqual({ ok: true });
    expect(commitField(`  ${'A'.repeat(40)} `)).toEqual({ ok: true, sha: 'a'.repeat(40) });
    expect(commitField('abc')).toEqual({ ok: false });
  });

  it('the proposal is saved with the CLI, never downloaded by the page', () => {
    expect(proposalCommand('INT-7', 'r-1')).toBe(
      'sdlc evidence proposal INT-7 --run r-1 --output <file>',
    );
    const page = fs.readFileSync(path.join(dashboardSrc, 'views/IntentDetail.tsx'), 'utf8');
    expect(page).not.toMatch(/\/proposal\b/);
    const reads = fs.readFileSync(path.join(dashboardSrc, 'api/reads.ts'), 'utf8');
    expect(reads).not.toContain('/proposal');
  });

  it('no U08 action asks for a passkey (ADR-M73 §2.1: no step-up)', () => {
    for (const file of ['components/CreateIntentModal.tsx', 'components/IntakeActions.tsx']) {
      const text = fs.readFileSync(path.join(dashboardSrc, file), 'utf8');
      expect(text, file).not.toMatch(/stepUpOptions|startAuthentication|step_up:/);
    }
  });
});
