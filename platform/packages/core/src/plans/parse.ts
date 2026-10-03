// Parsing a plan file, schema version 1 (task B09, D-08 B09 AC1–AC2, design/ADR-M40 §2.2,
// QUESTIONS #165, #166; template T13). The platform keeps coded fields only:
// - the path patterns of every task (the union is `plans.planned_files`, checked at G5);
// - the agent tools of every task (the union is `plans.allowed_tools`, used at G4);
// - the change flags (forced HITL at G3, dual approval at G7), declared in the file and checked by
//   Person B at G3 (QUESTIONS #166).
// Free text (summaries, inputs, outputs, definitions of done, escalation conditions) is allowed
// and never stored: it stays in the repository. Keys the platform owns are refused. The YAML is
// read with the configuration's safe reader (core schema, strict, no duplicate keys), with no
// alias at all. Core uses no schema library (ADR-M09): the checks below are explicit.
import { readYamlMapping } from '@sdlc/config';
import { AGENT_TOOLS, CHANGE_FLAGS, type AgentTool, type ChangeFlag } from '@sdlc/contracts';

import {
  PLAN_MAX_PATHS,
  PLAN_MAX_TASK_PATHS,
  PLAN_MAX_TASKS,
  patternRefusal,
  type PlanInvalidReason,
} from './rules.js';

/** What the platform keeps of a valid plan file. */
export interface ParsedPlan {
  /** Sorted, unique: the union of every task's `allowed_paths`. */
  readonly plannedFiles: readonly string[];
  /** Sorted, unique: the union of every task's `tools`. */
  readonly allowedTools: readonly AgentTool[];
  /** Sorted, unique. */
  readonly changeFlags: readonly ChangeFlag[];
}

export type PlanParse =
  | { readonly ok: true; readonly plan: ParsedPlan }
  | { readonly ok: false; readonly reason: PlanInvalidReason };

/**
 * Keys the platform owns (QUESTIONS #165): approvals are gate decisions, risk tier and data class
 * belong to the intent, versions are numbered by the platform, and the run caps come from the
 * project configuration and the intent's budget (a plan budget would conflict with G5's budget
 * increase).
 */
const PLATFORM_PLAN_KEYS: ReadonlySet<string> = new Set([
  'approved_by',
  'approved_at',
  'risk_tier',
  'data_class',
  'autonomy_level',
  'plan_version',
  'spec_version',
]);
const PLATFORM_TASK_KEYS: ReadonlySet<string> = new Set(['limits']);

const TOP_KEYS: ReadonlySet<string> = new Set(['plan', 'tasks']);
const PLAN_KEYS: ReadonlySet<string> = new Set(['intent_id', 'change_flags', 'adr_refs']);
/** Coded task fields, then free-text or informative ones (allowed, never stored). */
const TASK_KEYS: ReadonlySet<string> = new Set([
  'id',
  'allowed_paths',
  'tools',
  'environments',
  'summary',
  'owner_agent',
  'depends_on',
  'input',
  'output',
  'definition_of_done',
  'required_evidence',
  'escalate_when',
  'checkpoint',
]);

const TASK_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_ADR_REFS = 50;

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Mapping, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function stringList(value: unknown, min: number, max: number): string[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > max) return null;
  return value.every((item) => typeof item === 'string') ? value : null;
}

class Refused extends Error {
  constructor(readonly reason: PlanInvalidReason) {
    super(reason);
  }
}

function refuse(reason: PlanInvalidReason): never {
  throw new Refused(reason);
}

function readPlanBlock(value: unknown, intentCode: string): ChangeFlag[] {
  if (!isMapping(value)) refuse('schema_invalid');
  if (Object.keys(value).some((key) => PLATFORM_PLAN_KEYS.has(key))) refuse('platform_field');
  if (!onlyKeys(value, PLAN_KEYS) || typeof value.intent_id !== 'string') refuse('schema_invalid');
  if (value.adr_refs !== undefined) {
    const refs = stringList(value.adr_refs, 0, MAX_ADR_REFS);
    if (!refs || refs.some((r) => r.length > 200)) refuse('schema_invalid');
  }
  let flags: string[] = [];
  if (value.change_flags !== undefined) {
    const list = stringList(value.change_flags, 0, CHANGE_FLAGS.length);
    if (!list || list.some((f) => !(CHANGE_FLAGS as readonly string[]).includes(f))) {
      refuse('schema_invalid');
    }
    flags = list;
  }
  if (value.intent_id !== intentCode) refuse('intent_mismatch');
  return [...new Set(flags as ChangeFlag[])].sort();
}

interface Task {
  readonly id: string;
  readonly paths: readonly string[];
  readonly tools: readonly AgentTool[];
}

function readTask(value: unknown): Task {
  if (!isMapping(value)) refuse('schema_invalid');
  if (Object.keys(value).some((key) => PLATFORM_TASK_KEYS.has(key))) refuse('platform_field');
  if (!onlyKeys(value, TASK_KEYS)) refuse('schema_invalid');
  const tools = stringList(value.tools, 1, AGENT_TOOLS.length);
  if (
    Array.isArray(value.tools) &&
    value.tools.some((t) => !AGENT_TOOLS.includes(t as AgentTool))
  ) {
    refuse('unknown_tool');
  }
  const paths = stringList(value.allowed_paths, 1, PLAN_MAX_TASK_PATHS);
  if (typeof value.id !== 'string' || !TASK_ID.test(value.id) || !tools || !paths) {
    refuse('schema_invalid');
  }
  // Runs happen in the sandbox only in the MVP.
  if (value.environments !== undefined) {
    const envs = stringList(value.environments, 1, 1);
    if (envs?.[0] !== 'sandbox') refuse('schema_invalid');
  }
  return { id: value.id, paths, tools: tools as AgentTool[] };
}

function readTasks(value: unknown): Task[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PLAN_MAX_TASKS) {
    refuse('schema_invalid');
  }
  const tasks = value.map((task) => readTask(task));
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) refuse('schema_invalid');
  return tasks;
}

/** Parses and checks a plan file for the intent `intentCode`. */
export function parsePlanFile(text: string, intentCode: string): PlanParse {
  const yaml = readYamlMapping(text, { maxAliasCount: 0 });
  if (!yaml.ok) return { ok: false, reason: 'yaml_invalid' };
  const root = yaml.value;
  try {
    if (!onlyKeys(root, TOP_KEYS)) refuse('schema_invalid');
    // Platform fields first, so the reason is specific even when other keys are missing.
    const changeFlags = readPlanBlock(root.plan, intentCode);
    const tasks = readTasks(root.tasks);
    const patterns = [...new Set(tasks.flatMap((task) => task.paths))].sort();
    for (const pattern of patterns) {
      const refusal = patternRefusal(pattern);
      if (refusal) refuse(refusal);
    }
    if (patterns.length > PLAN_MAX_PATHS) refuse('too_many_paths');
    return {
      ok: true,
      plan: {
        plannedFiles: patterns,
        allowedTools: [...new Set(tasks.flatMap((task) => task.tools))].sort(),
        changeFlags,
      },
    };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}
