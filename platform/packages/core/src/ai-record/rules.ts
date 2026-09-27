// Rules of the project AI record (task B12, design/ADR-M32 §3; handbook Chapter 2 §2.4–§2.5,
// template T7; D-02 FR-19).
//
// These are **not configuration**: they are the floor that handbook Chapter 2 sets for every
// project (approved by Harry in the B12 plan). The record's values (allowed classes, consent,
// production logs, disclosure format) are data the client decides; they come from the record.
// - `prohibited` is never allowed (Ch.2 Rule 2, D-05 §5).
// - AI use `no` allows no `client_*` class (Ch.2 Rule 3).
// - While consent is unknown (no written answer, `confirmed_at` empty), client data is handled
//   only as `client_restricted`: `client_confidential` is not allowed (Ch.2 Rule 3, FR-19,
//   QUESTIONS.md #105). The intent's data class is never raised by the platform.
// - A confirmed record links the written answer (`record_ref`).
// - G1 fails when the record is missing or does not allow the intent's data class (FR-19).
// The database repeats the first four as CHECK constraints (migration 0010).
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import {
  AI_ALLOWED_VALUES,
  DATA_CLASSES,
  DISCLOSURE_FORMATS,
  PROD_LOGS_ALLOWED_VALUES,
  type AiAllowed,
  type AiConsent,
  type DataClass,
  type DisclosureFormat,
  type GateReasonCode,
  type ProdLogsAllowed,
  type ProjectAiFacts,
} from '@sdlc/contracts';

/** The coded content of a project AI record: everything the platform stores (ADR-M32 §2.1). */
export interface AiRecordContent {
  readonly aiAllowed: AiAllowed;
  readonly allowedDataClasses: readonly DataClass[];
  readonly prodLogsAllowed: ProdLogsAllowed;
  readonly disclosureFormat: DisclosureFormat;
  /** `YYYY-MM-DD`: when the client confirmed in writing; null while consent is unknown. */
  readonly confirmedAt: string | null;
  /** `https://` link to the human AI record (T7), which holds contact, tools, locations. */
  readonly recordRef: string | null;
}

export type AiRecordViolation =
  /** A field does not have the expected format. */
  | 'invalid_input'
  /** `prohibited` is never allowed (Ch.2 Rule 2). */
  | 'prohibited_class'
  /** AI use `no` with a `client_*` class. */
  | 'client_class_without_ai'
  /** `client_confidential` while consent is unknown (Ch.2 Rule 3). */
  | 'unconfirmed_confidential'
  /** A confirmed record without a link to the written answer. */
  | 'confirmed_without_ref';

export const CLIENT_DATA_CLASSES: readonly DataClass[] = [
  'client_confidential',
  'client_restricted',
];

const HTTPS_REF = /^https:\/\/\S+$/;
const MAX_REF = 512;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Input may come from a CLI or JSON: check the shape without narrowing the element type. */
const isList = (value: unknown): boolean => Array.isArray(value);

const includes = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/**
 * The first rule the content breaks, with the field for `invalid_input`, or null. `today`
 * (`YYYY-MM-DD`, UTC) refuses a confirmation date in the future.
 */
export function aiRecordViolation(
  content: AiRecordContent,
  today: string,
): { readonly violation: AiRecordViolation; readonly field?: string } | null {
  if (!includes(AI_ALLOWED_VALUES, content.aiAllowed)) {
    return { violation: 'invalid_input', field: 'ai_allowed' };
  }
  const classes: readonly DataClass[] = content.allowedDataClasses;
  if (
    !isList(classes) ||
    classes.some((c) => !includes(DATA_CLASSES, c)) ||
    new Set(classes).size !== classes.length
  ) {
    return { violation: 'invalid_input', field: 'allowed_data_classes' };
  }
  if (!includes(PROD_LOGS_ALLOWED_VALUES, content.prodLogsAllowed)) {
    return { violation: 'invalid_input', field: 'prod_logs_allowed' };
  }
  if (!includes(DISCLOSURE_FORMATS, content.disclosureFormat)) {
    return { violation: 'invalid_input', field: 'disclosure_format' };
  }
  if (
    content.confirmedAt !== null &&
    (typeof content.confirmedAt !== 'string' ||
      !isDate(content.confirmedAt) ||
      content.confirmedAt > today)
  ) {
    return { violation: 'invalid_input', field: 'confirmed_at' };
  }
  if (
    content.recordRef !== null &&
    (typeof content.recordRef !== 'string' ||
      !HTTPS_REF.test(content.recordRef) ||
      content.recordRef.length > MAX_REF)
  ) {
    return { violation: 'invalid_input', field: 'record_ref' };
  }
  if (classes.includes('prohibited')) return { violation: 'prohibited_class' };
  if (content.aiAllowed === 'no' && classes.some((c) => CLIENT_DATA_CLASSES.includes(c))) {
    return { violation: 'client_class_without_ai' };
  }
  if (content.confirmedAt === null && classes.includes('client_confidential')) {
    return { violation: 'unconfirmed_confidential' };
  }
  if (content.confirmedAt !== null && content.recordRef === null) {
    return { violation: 'confirmed_without_ref' };
  }
  return null;
}

/** Allowed classes in the canonical order of `DATA_CLASSES`. */
export function sortDataClasses(classes: readonly DataClass[]): DataClass[] {
  return DATA_CLASSES.filter((c) => classes.includes(c));
}

export function consentOf(confirmedAt: string | null): AiConsent {
  return confirmedAt === null ? 'unknown' : 'confirmed';
}

/**
 * SHA-256 of the RFC 8785 canonical JSON of the coded record (ADR-M32 §2.2). Version 1 of the
 * field list; changing it needs a new `v`.
 */
export function aiRecordSha256(content: AiRecordContent): string {
  const json = canonicalJson({
    v: 1,
    ai_allowed: content.aiAllowed,
    allowed_data_classes: sortDataClasses(content.allowedDataClasses),
    prod_logs_allowed: content.prodLogsAllowed,
    disclosure_format: content.disclosureFormat,
    confirmed_at: content.confirmedAt,
    record_ref: content.recordRef,
  });
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * The data classes the record allows, after the fixed rules above. The database refuses records
 * that break them; applying them again here keeps the check safe on its own.
 */
export function effectiveDataClasses(facts: ProjectAiFacts): DataClass[] {
  return sortDataClasses(facts.allowedDataClasses).filter((c) => {
    if (c === 'prohibited') return false;
    if (facts.aiAllowed === 'no' && CLIENT_DATA_CLASSES.includes(c)) return false;
    if (facts.consent !== 'confirmed' && c === 'client_confidential') return false;
    return true;
  });
}

/**
 * The G1 check of D-02 FR-19: the reason code when the intent may not enter G1, or null.
 * Also used before a run (C06, G4).
 */
export function aiRecordRefusal(
  facts: ProjectAiFacts | null,
  dataClass: DataClass,
): Extract<GateReasonCode, 'ai_record_missing' | 'data_class_not_allowed'> | null {
  if (facts === null) return 'ai_record_missing';
  return effectiveDataClasses(facts).includes(dataClass) ? null : 'data_class_not_allowed';
}
