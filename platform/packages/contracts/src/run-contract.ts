// The Run Contract (design/D-03 section 8, D-08 C02, design/ADR-M22): the signed permission for
// one agent run. The worker issues it after G4; the runner verifies it before it creates the
// sandbox. The signed bytes are the RFC 8785 canonical JSON of the contract (core
// `runContractBytes`); the signature is an Ed25519 signature made by OpenBao Transit.
//
// Values are strings, integers and arrays only (no floating point, D-05 D6), so the canonical
// bytes are the same after a round trip through PostgreSQL jsonb. Lists that act as sets
// (`allowed_tools`, `allowed_models`, `egress_allowlist`) must be sorted and unique, so the same
// set always gives the same bytes.
import type { AutonomyLevel } from './codes.js';

export const RUN_CONTRACT_SCHEMA_VERSION = 1;

/** Autonomy levels a contract may grant: L0 never runs an agent (D-02 FR-03), L3+ not in the MVP. */
export const RUN_CONTRACT_AUTONOMY_LEVELS = [
  'L1',
  'L2',
] as const satisfies readonly AutonomyLevel[];
export type RunContractAutonomy = (typeof RUN_CONTRACT_AUTONOMY_LEVELS)[number];

export interface RunContract {
  readonly schema_version: typeof RUN_CONTRACT_SCHEMA_VERSION;
  readonly run_id: string;
  readonly intent_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  /** `owner/name` on the Git host. */
  readonly repo: string;
  readonly base_sha: string;
  /** `agent/INT-YYYY-NNNN`: the only branch the agent may push (D-02 FR-30). */
  readonly branch: string;
  /** The plan approved at G3 and its hash. */
  readonly plan_id: string;
  readonly plan_sha256: string;
  /** Files or path patterns from the G3 plan (G5 compares the real changes with them). */
  readonly planned_files: readonly string[];
  /** From the agent register (C10). */
  readonly agent_id: string;
  readonly agent_version: string;
  readonly instructions_sha256: string;
  /**
   * Tools the agent may use in this run: the agent's registered tools that the plan task also
   * lists (handbook Ch.13 G4, template T13; QUESTIONS.md #34). Sorted, unique; may be empty.
   */
  readonly allowed_tools: readonly string[];
  readonly autonomy_level: RunContractAutonomy;
  /** Cost cap in USD as a decimal string (`"2"`, `"0.5"`, at most 6 decimals). */
  readonly max_budget_usd: string;
  readonly max_iterations: number;
  readonly max_duration_min: number;
  /** More identical consecutive tool calls than this stops the run (D-02 FR-35). */
  readonly loop_threshold: number;
  /** Model names allowed by policy for the intent's data class. Sorted, unique, at least one. */
  readonly allowed_models: readonly string[];
  /** Host names the sandbox may reach (GitHub, LiteLLM; D-03 section 9). Sorted, unique. */
  readonly egress_allowlist: readonly string[];
  /** ISO 8601 UTC with milliseconds, for example `2026-09-26T08:00:00.000Z`. */
  readonly issued_at: string;
  readonly expires_at: string;
}

/** What the worker hands to the runner. */
export interface RunContractEnvelope {
  readonly contract: RunContract;
  /** Transit signature, `vault:v<N>:<base64>`; `N` is the signing key version. */
  readonly signature: string;
}

/** Why the runner refused a contract (ADR-M22 section 2.4). Codes only; texts in the catalog. */
export const RUN_CONTRACT_REJECT_REASONS = [
  'malformed',
  'bad_signature',
  'unknown_contract',
  'mismatch',
  'not_yet_valid',
  'expired',
  'revoked',
  'run_not_startable',
] as const;
export type RunContractRejectReason = (typeof RUN_CONTRACT_REJECT_REASONS)[number];

export type RunContractValidation =
  | { readonly ok: true; readonly contract: RunContract }
  | { readonly ok: false; readonly field: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^agent\/INT-[0-9]{4}-[0-9]{4,9}$/;
const VERSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const HOST =
  /^(?=.{1,253}(:|$))[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$/;
const USD = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const SIGNATURE = /^vault:v([1-9][0-9]{0,8}):[A-Za-z0-9+/]+={0,2}$/;

const MAX_PLANNED_FILES = 1000;
const MAX_LIST = 100;

type Check = (value: unknown) => boolean;

const text =
  (pattern: RegExp): Check =>
  (value) =>
    typeof value === 'string' && pattern.test(value);

const positiveInt: Check = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

const plannedFiles: Check = (value) =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= MAX_PLANNED_FILES &&
  value.every(
    (f) => typeof f === 'string' && f.length >= 1 && f.length <= 1024 && !f.includes('\0'),
  );

/** A sorted list of unique strings that match `pattern`. */
const sortedSet =
  (pattern: RegExp, min: number): Check =>
  (value) =>
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= MAX_LIST &&
    value.every(
      (item, i) =>
        typeof item === 'string' &&
        pattern.test(item) &&
        (i === 0 || (value[i - 1] as string) < item),
    );

const timestamp: Check = (value) =>
  typeof value === 'string' &&
  TIMESTAMP.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const budget: Check = (value) => typeof value === 'string' && USD.test(value) && Number(value) > 0;

const FIELDS: Readonly<Record<keyof RunContract, Check>> = {
  schema_version: (value) => value === RUN_CONTRACT_SCHEMA_VERSION,
  run_id: text(UUID),
  intent_id: text(UUID),
  tenant_id: text(UUID),
  project_id: text(UUID),
  repo: text(REPO),
  base_sha: text(GIT_SHA),
  branch: text(BRANCH),
  plan_id: text(UUID),
  plan_sha256: text(SHA256),
  planned_files: plannedFiles,
  agent_id: text(UUID),
  agent_version: text(VERSION_LABEL),
  instructions_sha256: text(SHA256),
  allowed_tools: sortedSet(TOOL, 0),
  autonomy_level: (value) =>
    typeof value === 'string' &&
    (RUN_CONTRACT_AUTONOMY_LEVELS as readonly string[]).includes(value),
  max_budget_usd: budget,
  max_iterations: positiveInt,
  max_duration_min: positiveInt,
  loop_threshold: positiveInt,
  allowed_models: sortedSet(MODEL, 1),
  egress_allowlist: sortedSet(HOST, 1),
  issued_at: timestamp,
  expires_at: timestamp,
};

/** The contract fields, in schema order. */
export const RUN_CONTRACT_FIELDS = Object.keys(FIELDS) as readonly (keyof RunContract)[];

/**
 * Checks a value against the Run Contract schema: every field present with the right format, no
 * other field, and `expires_at` after `issued_at`. Returns the first field that fails.
 */
export function validateRunContract(value: unknown): RunContractValidation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, field: '(contract)' };
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).find((key) => !Object.hasOwn(FIELDS, key));
  if (extra !== undefined) return { ok: false, field: extra };
  for (const field of RUN_CONTRACT_FIELDS) {
    if (!FIELDS[field](record[field])) return { ok: false, field };
  }
  if (Date.parse(record.expires_at as string) <= Date.parse(record.issued_at as string)) {
    return { ok: false, field: 'expires_at' };
  }
  return { ok: true, contract: value as RunContract };
}

/** The signing key version in a Transit signature (`vault:v<N>:…`), or undefined when malformed. */
export function signatureKeyVersion(signature: unknown): number | undefined {
  if (typeof signature !== 'string' || signature.length > 512) return undefined;
  const match = SIGNATURE.exec(signature);
  return match ? Number(match[1]) : undefined;
}

/** A well-formed envelope: a valid contract and a well-formed signature with its key version. */
export interface ParsedRunContractEnvelope {
  readonly contract: RunContract;
  readonly signature: string;
  readonly keyVersion: number;
}

/**
 * Checks the shape of an envelope received by the runner: exactly `contract` and `signature`, a
 * valid contract and a `vault:v<N>:…` signature. Undefined when anything is malformed. The
 * signature itself is not verified here.
 */
export function parseRunContractEnvelope(value: unknown): ParsedRunContractEnvelope | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'contract' || keys[1] !== 'signature') return undefined;
  const validation = validateRunContract(record.contract);
  const keyVersion = signatureKeyVersion(record.signature);
  if (!validation.ok || keyVersion === undefined) return undefined;
  return { contract: validation.contract, signature: record.signature as string, keyVersion };
}
