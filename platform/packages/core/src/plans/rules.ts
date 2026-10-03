// The rules of a plan file (task B09, D-08 B09 AC1, design/ADR-M40 §2.2, QUESTIONS #165). These
// are design, not configuration. The plan is `.sdlc/plans/<intent code>.yaml` in the repository
// (template T13); the platform keeps its SHA-256 and coded fields only.
//
// Path patterns use the glob language of the G5 scope check (`PolicyEngine.checkScope`, Node's
// `path.posix.matchesGlob`), so a pattern means the same thing here and at G5. A plan may not
// allow (QUESTIONS #165):
// - every file: a pattern that matches an arbitrary file in an arbitrary folder (`**`, `*/**`);
// - paths G5 fails anyway or that steer the agent or CI: anything under `.github/` or `.sdlc/`
//   (the plans themselves), the instruction files at the root and in the skill folders, and a
//   pattern that names an instruction file (`CLAUDE.md`, `src/**/AGENTS.md`;
//   `isAgentInstructionPath`).
// The check probes each pattern with sample paths. It is a second line of defence: G5 still fails
// a change of any instruction file, and a change under `.github/` or `.sdlc/` is out of scope as
// long as no pattern matches it. An `AGENTS.md` in a sub-folder is an instruction file too, but
// every folder pattern (`src/**`) would match it: such a pattern is accepted, and G5 fails the
// change if the agent makes one.
import { createHash } from 'node:crypto';
import path from 'node:path';

import { isAgentInstructionPath } from '@sdlc/contracts';

/** Folder of the plan files in the repository (template T13). */
export const PLAN_DIR = '.sdlc/plans';

/** The plan file of an intent (D-08 B09 AC1). */
export function planPath(intentCode: string): string {
  return `${PLAN_DIR}/${intentCode}.yaml`;
}

/** Largest plan file the platform reads, in bytes (64 KiB, QUESTIONS #165). */
export const PLAN_MAX_BYTES = 64 * 1024;
/** Tasks in one plan. */
export const PLAN_MAX_TASKS = 20;
/** Path patterns in one task. */
export const PLAN_MAX_TASK_PATHS = 200;
/** Distinct path patterns of the whole plan (the limit of `plans.planned_files`). */
export const PLAN_MAX_PATHS = 1000;
/** Longest path pattern. */
export const PLAN_MAX_PATTERN_LENGTH = 1024;

/** Why a plan file cannot be read at a commit. Codes only. */
export const PLAN_UNREADABLE_CAUSES = ['missing', 'not_a_file', 'too_large', 'not_utf8'] as const;
export type PlanUnreadableCause = (typeof PLAN_UNREADABLE_CAUSES)[number];

/** Why a plan file that could be read is refused. Codes only. */
export const PLAN_INVALID_REASONS = [
  /** Not YAML the platform reads: syntax, duplicate keys, aliases, tags. */
  'yaml_invalid',
  /** Not the plan schema (missing or unknown keys, wrong types, duplicate task IDs). */
  'schema_invalid',
  /** `plan.intent_id` is not the intent's code. */
  'intent_mismatch',
  /** A key the platform owns: approvals, the intent's risk and data class, versions, limits. */
  'platform_field',
  /** A tool that is not an agent tool (`file_editor`, `task_tracker`, `terminal`). */
  'unknown_tool',
  /** A path pattern that is not a safe relative path. */
  'invalid_pattern',
  /** A path pattern that matches every file, such as `**`. */
  'pattern_too_broad',
  /** A path pattern that matches `.github/`, `.sdlc/` or an agent instruction file. */
  'protected_path',
  /** More than `PLAN_MAX_PATHS` distinct path patterns. */
  'too_many_paths',
] as const;
export type PlanInvalidReason = (typeof PLAN_INVALID_REASONS)[number];

/** Every reason a plan file is not accepted. */
export type PlanRefusal = PlanUnreadableCause | PlanInvalidReason;

/** SHA-256 of the plan file's bytes (the Git host returns strict UTF-8 text, BOM kept). */
export function planFileSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A repository-relative POSIX path with no empty, `.` or `..` segment. */
function isSafePattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > PLAN_MAX_PATTERN_LENGTH) return false;
  if (pattern.startsWith('/') || pattern.includes('\\') || pattern.includes('\0')) return false;
  return pattern.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function matches(file: string, pattern: string): boolean {
  return file === pattern || path.posix.matchesGlob(file, pattern);
}

/** Paths in folders and with names no plan would name: a pattern that matches one matches all. */
const ANY_FILE_PROBES = [
  'zz-probe.zz',
  'zz-probe',
  'zz-probe/zz-probe.zz',
  'zz-probe/zz-probe/zz-probe.zz',
];

/** Spellings of the instruction files (the agent reads them without case). */
const INSTRUCTION_NAMES = [
  'AGENTS.md',
  'agents.md',
  'Agents.md',
  'AGENTS.MD',
  'agent.md',
  'AGENT.md',
  'Agent.md',
  'CLAUDE.md',
  'claude.md',
  'Claude.md',
  'GEMINI.md',
  'gemini.md',
  'Gemini.md',
  '.cursorrules',
];

const PROTECTED_PROBES = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yaml',
  '.github/actions/setup/action.yml',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  '.github/pull_request_template.md',
  '.sdlc/plans/INT-2026-0001.yaml',
  '.sdlc/config.yaml',
  '.agents/skills/skill.md',
  '.openhands/skills/skill.md',
  '.openhands/microagents/repo.md',
  ...INSTRUCTION_NAMES,
];

/** True when the first segment is a protected folder (compared without case). */
function inProtectedFolder(pattern: string): boolean {
  const first = pattern.split('/')[0]!.normalize('NFC').toLowerCase();
  return first === '.github' || first === '.sdlc';
}

/** Why a path pattern is refused, or null when it is accepted. */
export function patternRefusal(
  pattern: string,
): Extract<PlanInvalidReason, 'invalid_pattern' | 'pattern_too_broad' | 'protected_path'> | null {
  if (!isSafePattern(pattern)) return 'invalid_pattern';
  if (ANY_FILE_PROBES.some((probe) => matches(probe, pattern))) return 'pattern_too_broad';
  if (inProtectedFolder(pattern) || isAgentInstructionPath(pattern)) return 'protected_path';
  return PROTECTED_PROBES.some((probe) => matches(probe, pattern)) ? 'protected_path' : null;
}
