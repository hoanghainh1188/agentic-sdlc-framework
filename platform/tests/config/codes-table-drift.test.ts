// Drift check: the default configuration must match the handbook codes table
// (handbook/00-introduction/05-codes.md) and the SLA resolve times (Ch.6 §6.4).
// Checked: §3 maximum autonomy, §4 gate × risk matrix (mode, on-breach switch, number of approvals),
// §4 forced-HITL G3 list, §4 dual-approval G7 list, §6.3 acknowledge times, Ch.6 §6.4 resolve times.
// Approver roles are not parsed from the free-text "Approver" column; the mandatory-rule tests
// cover Person B at G7 and G8 and the dual-approval roles.
import fs from 'node:fs';
import path from 'node:path';

import { defaultProjectConfig } from '@sdlc/config';
import type {
  ChangeFlag,
  Deadline,
  GateCheckMode,
  OversightCell,
  ProjectConfig,
  RiskTier,
  Severity,
} from '@sdlc/contracts';
import { RISK_TIERS, SEVERITIES } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const CODES_TABLE = 'handbook/00-introduction/05-codes.md';
const ESCALATION_CHAPTER = 'handbook/01-policy/ch06-governance-escalation-and-incidents.md';

const SAME_PR_RULE =
  'A codes-table change must be made together with the matching default-config change ' +
  '(platform/packages/config/defaults/project-config.default.yaml) in the same PR.';

function read(file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

/** Cells of a Markdown table row, trimmed, without the outer pipes. */
function cells(row: string): string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** Rows of the first table after `heading`, keyed by the first word of the first cell. */
function tableAfter(markdown: string, heading: string): Map<string, string[]> {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const lines = markdown.slice(start).split('\n');
  const first = lines.findIndex((line) => line.startsWith('|'));
  const rows = lines
    .slice(first)
    .filter((_, i, all) => all.slice(0, i + 1).every((l) => l.startsWith('|')));
  return new Map(rows.slice(2).map((row) => [cells(row)[0]?.split(' ')[0] ?? '', cells(row)]));
}

interface Expected {
  mode: GateCheckMode;
  on_breach?: 'HITL';
  approvals?: number;
}

/** Reads one matrix cell of codes table §4. Unknown wording fails the test (it needs a mapping). */
function expectedCell(text: string): Expected {
  const mode = /^(Automated \+ )?(HITL|HOTL|AUDIT)/.exec(text)?.[2] as GateCheckMode | undefined;
  if (text === 'Policy check') return { mode: 'POLICY' };
  if (text === 'HOTL → HITL on breach') return { mode: 'HOTL', on_breach: 'HITL' };
  if (/^HITL \+ (second approver|business\/security approval)$/.test(text))
    return { mode: 'HITL', approvals: 2 };
  if (mode !== undefined && /^(Automated \+ )?(HITL|HOTL|AUDIT)$/.test(text)) return { mode };
  throw new Error(`no mapping for codes-table cell "${text}"; extend expectedCell()`);
}

/** G8 cells name environments: "Production: HITL · non-production: HOTL". */
function expectedG8(text: string): { production: Expected; non_production?: Expected } {
  const production = /Production: (HITL|HOTL)/.exec(text)?.[1] as GateCheckMode | undefined;
  const nonProduction = /non-production: (HITL|HOTL)/.exec(text)?.[1] as GateCheckMode | undefined;
  if (production === undefined) {
    // No environment named: the value applies to both (Critical).
    const both = expectedCell(text);
    return { production: both, non_production: both };
  }
  return nonProduction === undefined
    ? { production: { mode: production } }
    : { production: { mode: production }, non_production: { mode: nonProduction } };
}

function compareCell(
  where: string,
  source: string,
  expected: Expected,
  actual: OversightCell,
): string[] {
  const diffs: string[] = [];
  const say = (what: string, want: unknown, got: unknown) =>
    diffs.push(
      `${where}: codes table "${source}" means ${what} ${String(want)}; default config has ${String(got)}`,
    );
  if (actual.mode !== expected.mode) say('mode', expected.mode, actual.mode);
  if ((expected.on_breach ?? undefined) !== actual.on_breach)
    say('on_breach', expected.on_breach ?? 'none', actual.on_breach ?? 'none');
  if ((expected.approvals ?? 1) !== actual.approvals)
    say('approvals', expected.approvals ?? 1, actual.approvals);
  return diffs;
}

function matrixDrift(markdown: string, config: ProjectConfig): string[] {
  const table = tableAfter(markdown, '## 4. Eight gates');
  const { matrix } = config.oversight;
  return (['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as const).flatMap((gate) => {
    const row = table.get(gate);
    if (row === undefined) return [`codes table §4: row ${gate} not found`];
    return RISK_TIERS.flatMap((tier, i) => {
      const text = row[3 + i] ?? '';
      if (gate !== 'G8') {
        return compareCell(
          `oversight.matrix.${gate}.${tier}`,
          text,
          expectedCell(text),
          matrix[gate][tier],
        );
      }
      const expected = expectedG8(text);
      return [
        ...compareCell(
          `oversight.matrix.G8.production.${tier}`,
          text,
          expected.production,
          matrix.G8.production[tier],
        ),
        ...(expected.non_production === undefined
          ? [] // Not in the codes table; default from Ch.15 §15.8 (design/QUESTIONS.md #7).
          : compareCell(
              `oversight.matrix.G8.non_production.${tier}`,
              text,
              expected.non_production,
              matrix.G8.non_production[tier],
            )),
      ];
    });
  });
}

const AUTONOMY_ROWS: Record<string, RiskTier> = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  Critical: 'critical',
};

function autonomyDrift(markdown: string, config: ProjectConfig): string[] {
  const table = tableAfter(markdown, '## 3. Risk tiers');
  return Object.entries(AUTONOMY_ROWS).flatMap(([row, tier]) => {
    const text = table.get(row)?.[2] ?? '';
    const expected = /^L[0-4]/.exec(text)?.[0];
    const actual = config.autonomy.max_by_risk[tier];
    return expected === actual
      ? []
      : [
          `autonomy.max_by_risk.${tier}: codes table §3 "${text}" means ${expected}; default config has ${actual}`,
        ];
  });
}

const FORCED_HITL_WORDING: Record<string, ChangeFlag> = {
  'a database migration or data-model change': 'migration',
  'a breaking API or event contract': 'breaking_contract',
  'a new service boundary': 'new_service_boundary',
  'a security-boundary or access change': 'security_boundary',
  'a change of system of record': 'system_of_record',
  'a production infrastructure change': 'prod_infrastructure',
  'a change to a core business rule (invariant)': 'core_business_rule',
};

const DUAL_APPROVAL_WORDING: Record<string, ChangeFlag> = {
  'data migrations': 'migration',
  'payment functions': 'payment',
  'personal data': 'personal_data',
  'production infrastructure': 'prod_infrastructure',
  'breaking changes': 'breaking_contract',
  'safety-related functions': 'safety_function',
};

/** Items of the bullet that starts with `marker`, split on `separator`, mapped to change flags. */
function flagList(
  markdown: string,
  marker: string,
  separator: string,
  wording: Record<string, ChangeFlag>,
): ChangeFlag[] {
  const bullet = markdown.split('\n').find((line) => line.startsWith(marker));
  if (bullet === undefined) throw new Error(`bullet not found: ${marker}`);
  const items =
    /: (.*?)\. Details:/.exec(bullet.slice(bullet.indexOf('whatever the risk tier')))?.[1] ?? '';
  return items.split(separator).map((item) => {
    const flag = wording[item.trim()];
    if (flag === undefined) throw new Error(`no change flag for codes-table item "${item.trim()}"`);
    return flag;
  });
}

function listDrift(
  where: string,
  expected: readonly ChangeFlag[],
  actual: readonly ChangeFlag[],
): string[] {
  const missing = expected.filter((flag) => !actual.includes(flag));
  const extra = actual.filter((flag) => !expected.includes(flag));
  return [
    ...missing.map((flag) => `${where}: codes table lists ${flag}; default config does not`),
    ...extra.map((flag) => `${where}: default config lists ${flag}; codes table does not`),
  ];
}

const SEVERITY_ROWS: Record<string, Severity> = {
  Critical: 'critical',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
};

/**
 * "**15 minutes**, to leadership", "1 hour (contain)", "Same working day", "Next planned work" →
 * a deadline. When part of the text is bold, only the bold part is the time.
 */
function expectedDeadline(text: string): Deadline {
  const time = /\*\*(.+?)\*\*/.exec(text)?.[1] ?? text;
  const plain = time
    .replace(/\s*\(.*\)$/, '')
    .trim()
    .toLowerCase();
  if (plain === 'same working day') return { kind: 'end_of_working_day' };
  if (plain === 'next planned work') return { kind: 'next_planned_work' };
  const match = /^(\d+) (minute|hour|working day)s?$/.exec(plain);
  if (match === null) throw new Error(`no mapping for SLA text "${text}"`);
  const unit = ({ minute: 'minutes', hour: 'hours', 'working day': 'working_days' } as const)[
    match[2] as 'minute' | 'hour' | 'working day'
  ];
  return { value: Number(match[1]), unit };
}

function slaDrift(codes: string, chapter: string, config: ProjectConfig): string[] {
  const acknowledge = tableAfter(codes, '### 6.3. Escalation severity');
  const resolve = tableAfter(chapter, '### SLA');
  return Object.entries(SEVERITY_ROWS).flatMap(([row, severity]) => {
    const sla = config.escalation.sla[severity];
    const pairs: [string, string, Deadline][] = [
      [`escalation.sla.${severity}.acknowledge`, acknowledge.get(row)?.[2] ?? '', sla.acknowledge],
      [`escalation.sla.${severity}.resolve`, resolve.get(row)?.[2] ?? '', sla.resolve],
    ];
    return pairs.flatMap(([where, text, actual]) => {
      const expected = expectedDeadline(text);
      return JSON.stringify(expected) === JSON.stringify(actual)
        ? []
        : [
            `${where}: handbook "${text}" means ${JSON.stringify(expected)}; default config has ${JSON.stringify(actual)}`,
          ];
    });
  });
}

/**
 * Codes table §4 row G6: "security findings go to HITL at any tier". The threshold
 * (`min_severity`) is a platform setting (design/QUESTIONS.md #19); the mode must match the table.
 */
function securityFindingsDrift(codes: string, config: ProjectConfig): string[] {
  const rowG6 = codes.split('\n').find((line) => line.startsWith('| G6 '));
  const saysHitl = rowG6?.includes('security findings go to HITL at any tier') === true;
  const mode = config.oversight.g6_security_findings.mode;
  return saysHitl && mode === 'HITL'
    ? []
    : [
        `oversight.g6_security_findings.mode: codes table §4 row G6 says security findings go to HITL; default config has ${mode}`,
      ];
}

/** Every difference between the handbook and `config`, one line per cell. */
function driftReport(config: ProjectConfig): string[] {
  const codes = read(CODES_TABLE);
  return [
    ...matrixDrift(codes, config),
    ...autonomyDrift(codes, config),
    ...listDrift(
      'oversight.forced_hitl_g3.change_flags',
      flagList(codes, '- **G3 is always HITL**', ';', FORCED_HITL_WORDING),
      config.oversight.forced_hitl_g3.change_flags,
    ),
    ...listDrift(
      'oversight.dual_approval_g7.change_flags',
      flagList(codes, '- **G7 needs two approvers**', ',', DUAL_APPROVAL_WORDING),
      config.oversight.dual_approval_g7.change_flags,
    ),
    ...securityFindingsDrift(codes, config),
    ...slaDrift(codes, read(ESCALATION_CHAPTER), config),
  ];
}

function failureMessage(diffs: readonly string[]): string {
  return [
    `The default configuration differs from the handbook codes table (${CODES_TABLE}):`,
    ...diffs.map((diff) => `  - ${diff}`),
    SAME_PR_RULE,
  ].join('\n');
}

describe('default configuration matches the handbook codes table', () => {
  it('has no drift', () => {
    const diffs = driftReport(defaultProjectConfig());
    expect(diffs, failureMessage(diffs)).toEqual([]);
  });

  it('names each differing cell and the same-PR rule when they drift', () => {
    const base = defaultProjectConfig();
    const drifted: ProjectConfig = {
      ...base,
      oversight: {
        ...base.oversight,
        matrix: {
          ...base.oversight.matrix,
          G2: {
            ...base.oversight.matrix.G2,
            low: { ...base.oversight.matrix.G2.low, mode: 'HITL' },
          },
        },
      },
      escalation: {
        ...base.escalation,
        sla: {
          ...base.escalation.sla,
          high: { ...base.escalation.sla.high, acknowledge: { value: 2, unit: 'hours' } },
        },
      },
    };
    const diffs = driftReport(drifted);
    expect(diffs).toEqual([
      'oversight.matrix.G2.low: codes table "HOTL" means mode HOTL; default config has HITL',
      'escalation.sla.high.acknowledge: handbook "**1 hour**" means {"value":1,"unit":"hours"}; default config has {"value":2,"unit":"hours"}',
    ]);
    const message = failureMessage(diffs);
    expect(message).toContain('  - oversight.matrix.G2.low:');
    expect(message).toContain('  - escalation.sla.high.acknowledge:');
    expect(message).toContain(SAME_PR_RULE);
  });

  it('covers every severity and risk tier', () => {
    expect(Object.values(SEVERITY_ROWS).sort()).toEqual([...SEVERITIES].sort());
    expect(Object.values(AUTONOMY_ROWS).sort()).toEqual([...RISK_TIERS].sort());
  });
});
