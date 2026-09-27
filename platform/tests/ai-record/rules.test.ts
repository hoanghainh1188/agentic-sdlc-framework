// D-08 B12: the rules of the project AI record (handbook Ch.2 Rules 2–3, template T7, D-02 FR-19,
// design/ADR-M32 §3). Pure functions; the database part is in tests/integration/db/ai-records.test.ts.
import { DATA_CLASSES, type DataClass, type ProjectAiFacts } from '@sdlc/contracts';
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import {
  AI_RECORD_ERROR_MESSAGES,
  AiRecordError,
  aiRecordErrorMessage,
} from '../../packages/core/src/ai-record/errors.js';
import {
  aiRecordRefusal,
  aiRecordSha256,
  aiRecordViolation,
  effectiveDataClasses,
  type AiRecordContent,
} from '../../packages/core/src/ai-record/rules.js';

const TODAY = '2026-09-27';
const REF = 'https://docs.example.test/project/ai-record';

const confirmed: AiRecordContent = {
  aiAllowed: 'yes_with_conditions',
  allowedDataClasses: ['internal', 'client_confidential'],
  prodLogsAllowed: 'no',
  disclosureFormat: 'standard_note',
  confirmedAt: '2026-09-24',
  recordRef: REF,
};

describe('aiRecordViolation (AC1)', () => {
  it('accepts a consistent record', () => {
    expect(aiRecordViolation(confirmed, TODAY)).toBeNull();
    expect(
      aiRecordViolation(
        { ...confirmed, allowedDataClasses: ['client_restricted'], confirmedAt: null },
        TODAY,
      ),
    ).toBeNull();
    expect(
      aiRecordViolation({ ...confirmed, aiAllowed: 'no', allowedDataClasses: ['internal'] }, TODAY),
    ).toBeNull();
    expect(aiRecordViolation({ ...confirmed, allowedDataClasses: [] }, TODAY)).toBeNull();
  });

  it.each<[string, Partial<AiRecordContent>, string, string?]>([
    ['prohibited is never allowed', { allowedDataClasses: ['prohibited'] }, 'prohibited_class'],
    [
      'AI use no allows no client class',
      { aiAllowed: 'no', allowedDataClasses: ['client_restricted'] },
      'client_class_without_ai',
    ],
    [
      'unknown consent never allows client_confidential',
      { confirmedAt: null },
      'unconfirmed_confidential',
    ],
    ['a confirmed record links the written answer', { recordRef: null }, 'confirmed_without_ref'],
    ['unknown AI use value', { aiAllowed: 'maybe' as never }, 'invalid_input', 'ai_allowed'],
    [
      'unknown data class',
      { allowedDataClasses: ['secret' as DataClass] },
      'invalid_input',
      'allowed_data_classes',
    ],
    [
      'duplicate data class',
      { allowedDataClasses: ['internal', 'internal'] },
      'invalid_input',
      'allowed_data_classes',
    ],
    [
      'unknown production logs value',
      { prodLogsAllowed: 'yes' as never },
      'invalid_input',
      'prod_logs_allowed',
    ],
    [
      'unknown disclosure format',
      { disclosureFormat: 'email' as never },
      'invalid_input',
      'disclosure_format',
    ],
    ['a date that does not exist', { confirmedAt: '2026-02-30' }, 'invalid_input', 'confirmed_at'],
    ['a date in the future', { confirmedAt: '2026-09-28' }, 'invalid_input', 'confirmed_at'],
    ['a date with a time', { confirmedAt: '2026-09-24T10:00' }, 'invalid_input', 'confirmed_at'],
    ['a link that is not https', { recordRef: 'http://x.test/a' }, 'invalid_input', 'record_ref'],
    [
      'free text instead of a link',
      { recordRef: 'Mr. Tanaka, e-mail of 2026-09-24' },
      'invalid_input',
      'record_ref',
    ],
    [
      'a link that is too long',
      { recordRef: `https://x.test/${'a'.repeat(512)}` },
      'invalid_input',
      'record_ref',
    ],
  ])('refuses: %s', (_name, change, violation, field) => {
    expect(aiRecordViolation({ ...confirmed, ...change }, TODAY)).toEqual(
      field === undefined ? { violation } : { violation, field },
    );
  });
});

describe('aiRecordSha256 (ADR-M32 §2.2)', () => {
  it('is stable and independent of the order of the classes', () => {
    const a = aiRecordSha256(confirmed);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(aiRecordSha256({ ...confirmed })).toBe(a);
    expect(
      aiRecordSha256({ ...confirmed, allowedDataClasses: ['client_confidential', 'internal'] }),
    ).toBe(a);
  });

  it.each<Partial<AiRecordContent>>([
    { aiAllowed: 'yes' },
    { allowedDataClasses: ['internal'] },
    { prodLogsAllowed: 'yes_masked' },
    { disclosureFormat: 'client_format' },
    { confirmedAt: '2026-09-25' },
    { recordRef: `${REF}#v2` },
  ])('changes when a field changes: %j', (change) => {
    expect(aiRecordSha256({ ...confirmed, ...change })).not.toBe(aiRecordSha256(confirmed));
  });
});

const facts = (change: Partial<ProjectAiFacts> = {}): ProjectAiFacts => ({
  version: 1,
  recordSha256: 'a'.repeat(64),
  aiAllowed: 'yes',
  allowedDataClasses: ['public', 'internal', 'client_confidential', 'client_restricted'],
  prodLogsAllowed: 'no',
  disclosureFormat: 'standard_note',
  consent: 'confirmed',
  ...change,
});

describe('aiRecordRefusal: the G1 check (AC2, FR-19)', () => {
  it('refuses every data class without a record', () => {
    for (const dataClass of DATA_CLASSES) {
      expect(aiRecordRefusal(null, dataClass)).toBe('ai_record_missing');
    }
  });

  it.each<[string, Partial<ProjectAiFacts>, DataClass, string | null]>([
    ['an allowed class', {}, 'client_confidential', null],
    [
      'a class the record does not list',
      { allowedDataClasses: ['internal'] },
      'public',
      'data_class_not_allowed',
    ],
    [
      'prohibited, even when listed',
      { allowedDataClasses: ['prohibited'] },
      'prohibited',
      'data_class_not_allowed',
    ],
    [
      'client_confidential while consent is unknown',
      { consent: 'unknown' },
      'client_confidential',
      'data_class_not_allowed',
    ],
    [
      'client_restricted while consent is unknown',
      { consent: 'unknown' },
      'client_restricted',
      null,
    ],
    ['internal while consent is unknown', { consent: 'unknown' }, 'internal', null],
    [
      'a client class when AI use is no',
      { aiAllowed: 'no' },
      'client_restricted',
      'data_class_not_allowed',
    ],
    ['internal when AI use is no', { aiAllowed: 'no' }, 'internal', null],
  ])('%s', (_name, change, dataClass, expected) => {
    expect(aiRecordRefusal(facts(change), dataClass)).toBe(expected);
  });

  it('effective classes keep the canonical order', () => {
    expect(
      effectiveDataClasses(facts({ allowedDataClasses: ['client_restricted', 'public'] })),
    ).toEqual(['public', 'client_restricted']);
  });
});

describe('refusal messages (NFR-08)', () => {
  it('every code has a complete catalog text', () => {
    for (const code of Object.keys(
      AI_RECORD_ERROR_MESSAGES,
    ) as (keyof typeof AI_RECORD_ERROR_MESSAGES)[]) {
      const text = aiRecordErrorMessage(new AiRecordError(code, 'x', 'record_ref'));
      expect(text).toBe(t(AI_RECORD_ERROR_MESSAGES[code], { field: 'record_ref' }));
      expect(text).not.toMatch(/\{[a-z_]+\}/);
    }
  });
});
