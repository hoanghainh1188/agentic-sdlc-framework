// Reads and validates project configuration (YAML). See design/D-03 section 11, D-08 A05, ADR-M18.
export {
  addWorkingMinutes,
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
  checkMandatoryRules,
  DUAL_APPROVAL_G7_FLAGS,
  DUAL_APPROVAL_ROLES,
  FORCED_HITL_G3_FLAGS,
  HANDBOOK_SLA,
  MANDATORY_RULES,
  MAX_IDENTICAL_TOOL_CALLS,
  MAX_STOP_PERCENT,
  MAX_WARN_PERCENT,
  MIN_WORKING_DAYS_PER_WEEK,
  MIN_WORKING_HOURS_PER_DAY,
  MVP_MAX_AUTONOMY,
} from './mandatory-rules.js';
export { MAX_HOLIDAYS_PER_YEAR } from './warnings.js';
