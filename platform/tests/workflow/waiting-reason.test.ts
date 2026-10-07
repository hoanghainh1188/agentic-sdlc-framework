// U02 (design/ADR-M54 §2.4b, D-08 U02 AC1, AC3): every waiting reason the workflow can record,
// and every G4 check it records as a cause, has a catalog label and passes migration 0025's
// format check. Causes stay open to later gates: unknown ones are shown as their code.
import fs from 'node:fs';
import path from 'node:path';

import { WAITING_CAUSE_KEYS, WAITING_REASON_KEYS } from '@sdlc/api-schemas';
import { INTENT_WAIT_REASONS } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const en = JSON.parse(
  fs.readFileSync(path.join(repoRoot(), 'platform/packages/messages/src/locales/en.json'), 'utf8'),
) as Record<string, string>;

describe('waiting reasons and causes', () => {
  it('every IntentWaitReason has a label in the catalog, and only those', () => {
    expect(Object.keys(WAITING_REASON_KEYS).sort()).toEqual([...INTENT_WAIT_REASONS].sort());
    for (const reason of INTENT_WAIT_REASONS) {
      expect(reason).toMatch(CODE);
      expect(en[WAITING_REASON_KEYS[reason]!], reason).toBeTruthy();
    }
  });

  it('every G4 check the step records has a cause label', () => {
    const g4 = fs.readFileSync(
      path.join(repoRoot(), 'platform/packages/core/src/workflow/g4.ts'),
      'utf8',
    );
    const literal = [...g4.matchAll(/check: '([a-z_]+)'/g)].map((m) => m[1]!);
    // The agent register's refusals (`check: error.code`) and the AI record's (`check: record`).
    const register = [
      'agent_not_found',
      'agent_not_active',
      'autonomy_above_agent',
      'environment_not_approved',
      'model_not_allowed',
      'model_not_pinned',
      'instructions_mismatch',
    ];
    const aiRecord = ['ai_record_missing', 'data_class_not_allowed'];
    for (const check of new Set([...literal, ...register, ...aiRecord])) {
      expect(check).toMatch(CODE);
      const key = WAITING_CAUSE_KEYS[check];
      expect(key, check).toBe(`intent.waiting_cause.${check}`);
      expect(en[key!], check).toBeTruthy();
    }
    for (const key of Object.values(WAITING_CAUSE_KEYS)) expect(en[key], key).toBeTruthy();
  });
});
