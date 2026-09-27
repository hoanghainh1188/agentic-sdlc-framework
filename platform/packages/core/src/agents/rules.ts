// Formats and lifecycle rules of the agent register (handbook Ch.20, template T6, D-05 section 6.1,
// design/ADR-M31). The status moves are also enforced by the database trigger of migration 0008;
// they are here so that refusals get a clear code before the database is reached.
import { createHash } from 'node:crypto';

import { MVP_MAX_AUTONOMY } from '@sdlc/config';
import { AUTONOMY_LEVELS, type AgentStatus, type AutonomyLevel } from '@sdlc/contracts';

import { AGENT_ENVIRONMENTS, type AgentEnvironment } from '../db/vocabulary.js';
import { AgentRegisterError } from './errors.js';

export const AGENT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
/** Same as the Run Contract's `agent_version`. */
export const AGENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** Same as the Run Contract's `allowed_models` entries. */
export const MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/** Same as the Run Contract's `allowed_tools` entries. */
export const TOOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** `<path in the repository>@<version label>`, for example `AGENTS.md@v5`. */
export const INSTRUCTIONS_REF_PATTERN =
  /^([A-Za-z0-9_][A-Za-z0-9._/-]{0,199})@([A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * Status moves of handbook Ch.20 (ADR-M31 §2.3). A quarantined agent is reviewed as suspended
 * before it can run again; retired is final.
 */
export const AGENT_STATUS_MOVES: Readonly<Record<AgentStatus, readonly AgentStatus[]>> = {
  proposed: ['active', 'retired'],
  active: ['suspended', 'quarantined', 'retired'],
  suspended: ['active', 'quarantined', 'retired'],
  quarantined: ['suspended', 'retired'],
  retired: [],
};

/** Statuses in which the configuration may change, with a new version (Ch.20 §20.9). */
export const AGENT_CHANGEABLE_STATUSES: readonly AgentStatus[] = ['proposed', 'suspended'];

/** Why an agent is suspended, quarantined or retired (Ch.20 §20.9–§20.10 triggers). Codes only. */
export const AGENT_STATUS_REASONS = [
  'incident',
  'quality',
  'security',
  'no_owner',
  'replaced',
  'unused',
  'provider_end_of_support',
  'other',
] as const;
export type AgentStatusReason = (typeof AGENT_STATUS_REASONS)[number];

/** The environment of every platform run (ADR-M25): the agent must be approved for it. */
export const RUN_ENVIRONMENT: AgentEnvironment = 'sandbox';

function invalid(field: string): never {
  throw new AgentRegisterError('invalid_input', `agent field ${field} is not valid`, field);
}

export function checkAgentKey(value: string): void {
  if (!AGENT_KEY_PATTERN.test(value)) invalid('agent_key');
}

export function checkVersion(value: string): void {
  if (!AGENT_VERSION_PATTERN.test(value)) invalid('version');
}

/**
 * A LiteLLM gateway model name. It must name the model version (ADR-M31 §2.4, Harry 2026-09-27):
 * at least one digit, and never an alias such as `latest` that moves by itself.
 */
export function checkModelRef(value: string): void {
  if (!MODEL_REF_PATTERN.test(value) || !/[0-9]/.test(value) || /latest/i.test(value)) {
    invalid('model_ref');
  }
}

/** Splits `AGENTS.md@v5` into the path in the repository and the version label. */
export function parseInstructionsRef(value: string): { path: string; label: string } {
  const match = INSTRUCTIONS_REF_PATTERN.exec(value);
  const path = match?.[1];
  const label = match?.[2];
  if (
    !path ||
    !label ||
    path.split('/').some((part) => part === '..' || part === '.' || part === '')
  ) {
    invalid('instructions_ref');
  }
  return { path, label };
}

export function checkSha256(value: string): void {
  if (!SHA256.test(value)) invalid('instructions_sha256');
}

/** SHA-256 (hex) of an instructions file's bytes. C06 hashes the file at the run's base commit. */
export function instructionsSha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function checkTools(tools: readonly string[]): string[] {
  if (tools.length > 100 || tools.some((tool) => !TOOL_PATTERN.test(tool)))
    invalid('allowed_tools');
  return [...new Set(tools)].sort();
}

/** The MVP allows agents up to L2 (D-02 FR-03 and §4.2; `MVP_MAX_AUTONOMY`). */
export function checkMaxAutonomy(value: string): AutonomyLevel {
  const index = (AUTONOMY_LEVELS as readonly string[]).indexOf(value);
  if (index < 0 || index > AUTONOMY_LEVELS.indexOf(MVP_MAX_AUTONOMY)) invalid('max_autonomy');
  return value as AutonomyLevel;
}

export function checkEnvironments(values: readonly string[]): AgentEnvironment[] {
  if (values.some((value) => !(AGENT_ENVIRONMENTS as readonly string[]).includes(value))) {
    invalid('approved_environments');
  }
  return [...new Set(values as readonly AgentEnvironment[])].sort();
}

export function isAgentStatusReason(value: string): value is AgentStatusReason {
  return (AGENT_STATUS_REASONS as readonly string[]).includes(value);
}

/** The UTC calendar day of `at`, as `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** A real calendar day `YYYY-MM-DD`. */
export function isCalendarDay(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === value;
}

/**
 * `day` plus `months` calendar months, clamped to the end of the month (30 November + 3 months =
 * the last day of February).
 */
export function addMonths(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return utcDay(target);
}

export interface RecertificationStatus {
  /** Last day the certification holds; null when the agent was never certified. */
  readonly dueOn: string | null;
  /** True after `dueOn`, or when the agent was never certified. */
  readonly overdue: boolean;
}

/**
 * Whether an agent's recertification is overdue (handbook Ch.20 §20.8, D-02 FR-36). `months` comes
 * from project configuration `agents.recertification_months` (at most 3, rule M18).
 */
export function recertificationStatus(
  lastRecertifiedAt: string | null,
  months: number,
  now: Date,
): RecertificationStatus {
  if (lastRecertifiedAt === null) return { dueOn: null, overdue: true };
  const dueOn = addMonths(lastRecertifiedAt, months);
  return { dueOn, overdue: utcDay(now) > dueOn };
}
