// Resolves the oversight mode of a gate (design/D-03 section 6.1, D-02 FR-14…FR-16).
// Every value comes from the validated configuration; this file only applies the steps:
//   mode = matrix[gate][risk_tier]          (G8: production or non-production table)
//   G3 + a forced-HITL change flag          → HITL
//   G5 + a breached limit                   → the cell's `on_breach` mode
//   G6 + a finding at or above min_severity → `g6_security_findings.mode`
//   G7 + a dual-approval change flag        → the dual-approval roles, one approval each
import type {
  ChangeFlag,
  GateCheckMode,
  OversightCell,
  OversightInput,
  OversightOverride,
  OversightResolution,
  ProjectRole,
  ValidatedProjectConfig,
} from '@sdlc/contracts';
import { SEVERITIES } from '@sdlc/contracts';

function matrixCell(config: ValidatedProjectConfig, input: OversightInput): OversightCell {
  const { matrix } = config.oversight;
  if (input.gate === 'G8') {
    const environment = input.context?.environment ?? 'production';
    return matrix.G8[environment][input.riskTier];
  }
  return matrix[input.gate][input.riskTier];
}

function hasAny(flags: readonly ChangeFlag[], listed: readonly ChangeFlag[]): boolean {
  return flags.some((flag) => listed.includes(flag));
}

/** True when a finding at or above the configured threshold exists. SEVERITIES: most severe first. */
function securityFindingAtThreshold(
  config: ValidatedProjectConfig,
  input: OversightInput,
): boolean {
  const findings = input.context?.securityFindings ?? {};
  const threshold = SEVERITIES.indexOf(config.oversight.g6_security_findings.min_severity);
  return SEVERITIES.slice(0, threshold + 1).some((severity) => (findings[severity] ?? 0) > 0);
}

function union(first: readonly ProjectRole[], second: readonly ProjectRole[]): ProjectRole[] {
  return [...first, ...second.filter((role) => !first.includes(role))];
}

interface Resolved {
  readonly mode: GateCheckMode;
  readonly roles: readonly ProjectRole[];
  readonly approvals: number;
  readonly overrides: readonly OversightOverride[];
}

function applyOverrides(
  config: ValidatedProjectConfig,
  input: OversightInput,
  cell: OversightCell,
): Resolved {
  const base: Resolved = {
    mode: cell.mode,
    roles: cell.roles,
    approvals: cell.approvals,
    overrides: [],
  };
  const { oversight } = config;
  switch (input.gate) {
    case 'G3':
      return hasAny(input.changeFlags, oversight.forced_hitl_g3.change_flags)
        ? { ...base, mode: 'HITL', overrides: ['forced_hitl_change_flag'] }
        : base;
    case 'G5':
      return input.context?.breached === true && cell.on_breach !== undefined
        ? { ...base, mode: cell.on_breach, overrides: ['limit_breached'] }
        : base;
    case 'G6':
      return securityFindingAtThreshold(config, input)
        ? { ...base, mode: oversight.g6_security_findings.mode, overrides: ['security_finding'] }
        : base;
    case 'G7': {
      const dual = oversight.dual_approval_g7;
      if (!hasAny(input.changeFlags, dual.change_flags)) return base;
      return {
        ...base,
        roles: union(dual.roles, cell.roles),
        approvals: Math.max(cell.approvals, dual.roles.length),
        overrides: ['dual_approval_change_flag'],
      };
    }
    default:
      return base;
  }
}

export function resolveOversight(
  config: ValidatedProjectConfig,
  input: OversightInput,
): OversightResolution {
  const cell = matrixCell(config, input);
  const resolved = applyOverrides(config, input, cell);
  return {
    mode: resolved.mode,
    approvalsNeeded: resolved.mode === 'HITL' ? resolved.approvals : 0,
    roles: resolved.mode === 'POLICY' ? [] : resolved.roles,
    overrides: resolved.overrides,
  };
}
