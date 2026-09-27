// The project AI record (handbook Chapter 2 section 2.5, template T7; design/D-05 section 6.1,
// task B12, design/ADR-M32). The platform keeps codes only; the human record (client contact,
// allowed tools and locations, special conditions) stays in the document that `record_ref` links.
import type { DataClass } from './codes.js';

/** Is AI use allowed on the client's material? */
export const AI_ALLOWED_VALUES = ['no', 'yes', 'yes_with_conditions'] as const;
export type AiAllowed = (typeof AI_ALLOWED_VALUES)[number];

/** Is AI allowed on production logs and data? Asked separately (T7). */
export const PROD_LOGS_ALLOWED_VALUES = ['no', 'yes_masked'] as const;
export type ProdLogsAllowed = (typeof PROD_LOGS_ALLOWED_VALUES)[number];

/** How the client is told about AI use (Ch.2 Rule 6, D-02 FR-43). */
export const DISCLOSURE_FORMATS = ['client_format', 'standard_note'] as const;
export type DisclosureFormat = (typeof DISCLOSURE_FORMATS)[number];

/** Whether the client answered in writing. `unknown` while `confirmed_at` is empty (Ch.2 Rule 3). */
export const AI_CONSENT_STATES = ['confirmed', 'unknown'] as const;
export type AiConsent = (typeof AI_CONSENT_STATES)[number];

/** The facts of a project AI record that rules and policy read. Codes only. */
export interface ProjectAiFacts {
  readonly version: number;
  /** SHA-256 of the RFC 8785 canonical JSON of the coded record (ADR-M32 §2.2). */
  readonly recordSha256: string;
  readonly aiAllowed: AiAllowed;
  readonly allowedDataClasses: readonly DataClass[];
  readonly prodLogsAllowed: ProdLogsAllowed;
  readonly disclosureFormat: DisclosureFormat;
  readonly consent: AiConsent;
}

/**
 * What an operations task may do with production logs and data (D-08 B12 AC3). `none`: no AI on
 * production data; `masked`: only masked production data.
 */
export type ProductionDataAccess = 'none' | 'masked';
