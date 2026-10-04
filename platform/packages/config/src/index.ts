// Reads and validates project configuration (YAML). See design/D-03 section 11, D-08 A05, ADR-M18.
export {
  addWorkingMinutes,
  durationMinutes,
  deadlineFrom,
  endOfWorkingDay,
  NoWorkingTimeError,
  workingDayMinutes,
} from './calendar.js';
export { canonicalJson } from './canonical-json.js';
export { computeConfigHash } from './hash.js';
export { formatIssue, type ConfigIssue } from './issues.js';
export {
  DEFAULT_CONFIG_PATH,
  defaultProjectConfig,
  loadProjectConfig,
  type ConfigResult,
} from './load.js';
export {
  ALWAYS_CONFLICTING_ROLES,
  ALWAYS_HITL_SECURITY_SEVERITY,
  checkMandatoryRules,
  DUAL_APPROVAL_G7_FLAGS,
  DUAL_APPROVAL_ROLES,
  ESCALATION_FINAL_ROLE,
  FORCED_HITL_G3_FLAGS,
  HANDBOOK_NOTIFY_ON_RAISE,
  HANDBOOK_SLA,
  MANDATORY_RULES,
  MAX_IDENTICAL_TOOL_CALLS,
  MAX_EVIDENCE_RETENTION_DAYS,
  MAX_NO_PROGRESS_WINDOW_MINUTES,
  MIN_EVIDENCE_RETENTION_DAYS,
  MAX_RECERTIFICATION_MONTHS,
  MAX_STOP_PERCENT,
  MAX_WARN_PERCENT,
  MIN_WORKING_DAYS_PER_WEEK,
  MIN_WORKING_HOURS_PER_DAY,
  MVP_MAX_AUTONOMY,
  severityAtOrAbove,
} from './mandatory-rules.js';
export { MAX_HOLIDAYS_PER_YEAR, MIN_NO_PROGRESS_WINDOW_MINUTES } from './warnings.js';
// B09 (ADR-M40 §2.2): core reads plan files with the same safe YAML reader.
export { readYamlMapping, type YamlResult } from './yaml.js';
