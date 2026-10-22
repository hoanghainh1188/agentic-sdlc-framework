// The register-tool check before each run (task X04, design/ADR-M69 §2.3). Gate G4 calls
// `checkToolsForRun` after the agent check (check 6) with the register tools the plan lists. A
// run gets a register tool only when all of these allow it:
//   1. the plan lists `tool:<key>` (the caller passes only those);
//   2. the agent lists it in its `allowed_tools`;
//   3. the tool is `active`, and the intent's data class is one of its `allowed_data_classes`
//      (and its model, if any, is one the data class may use: D-07 §4);
//   4. the agent's adapter supports the tool's transport (`ADAPTER_TOOL_TRANSPORTS`);
//   5. the Run Contract names it (`issueRunContract` builds the grants returned here).
// Refusals throw `ToolRegisterError` with the first failing code, tools in key order. A plan that
// asks for a tool the run cannot have fails G4 (`tool_not_runnable`) instead of dropping the tool.
// An overdue recertification is a warning, not a refusal (as for agents).
import { createHash } from 'node:crypto';

import {
  ADAPTER_TOOL_TRANSPORTS,
  isRegisterToolCode,
  toolCallRulesJson,
  toolKeyOf,
  type AgentAdapterCode,
  type DataClass,
  type ToolGrant,
  type ToolPermission,
  type ToolTransport,
} from '@sdlc/contracts';

import { recertificationStatus } from '../agents/rules.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { ToolRegisterError } from './errors.js';

/** SHA-256 (hex) of the canonical call rules of `permissions` (ADR-M69 §2.6, QUESTIONS #530). */
export function callRulesSha256(permissions: readonly ToolPermission[]): string {
  return createHash('sha256').update(toolCallRulesJson(permissions), 'utf8').digest('hex');
}

export interface ToolRunCheck {
  /** The register tools the plan lists (`tool:<key>`). Other codes are ignored. */
  readonly planTools: readonly string[];
  /** The agent's `allowed_tools` in the register. */
  readonly agentTools: readonly string[];
  readonly adapter: AgentAdapterCode;
  /** The transports the adapter supports. Default: `ADAPTER_TOOL_TRANSPORTS[adapter]`. */
  readonly transports?: readonly ToolTransport[];
  readonly dataClass: DataClass;
  /** The models the intent's data class may use (the G4 facts). */
  readonly allowedModels: readonly string[];
  /** Project configuration `tools.max_calls_per_run`. */
  readonly maxCallsPerRun: number;
  /** Project configuration `tools.recertification_months`. */
  readonly recertificationMonths: number;
  readonly now: Date;
}

export interface CheckedTools {
  /** One grant per register tool, sorted by key; empty when the plan lists none. */
  readonly grants: readonly ToolGrant[];
  /** Tools whose recertification is overdue (a warning). */
  readonly overdue: readonly { readonly id: string; readonly key: string }[];
}

export async function checkToolsForRun(
  scope: TenantScope,
  input: ToolRunCheck,
): Promise<CheckedTools> {
  const keys = [...new Set(input.planTools.filter(isRegisterToolCode).map(toolKeyOf))].sort();
  if (keys.length === 0) return { grants: [], overdue: [] };
  const byKey = new Map((await scope.tools.listByKeys(keys)).map((tool) => [tool.tool_key, tool]));
  const grants: ToolGrant[] = [];
  const overdue: { id: string; key: string }[] = [];
  for (const key of keys) {
    const tool = byKey.get(key);
    if (!tool) throw new ToolRegisterError('tool_not_found', `no tool ${key}`, undefined, key);
    if (!input.agentTools.includes(`tool:${key}`)) {
      throw new ToolRegisterError(
        'tool_not_allowed_for_agent',
        `the agent may not use ${key}`,
        undefined,
        key,
      );
    }
    if (tool.status !== 'active') {
      throw new ToolRegisterError(
        'tool_not_active',
        `tool ${key} is ${tool.status}`,
        undefined,
        key,
      );
    }
    if (
      !tool.allowed_data_classes.includes(input.dataClass) ||
      (tool.model_ref !== null && !input.allowedModels.includes(tool.model_ref))
    ) {
      throw new ToolRegisterError(
        'tool_data_class_not_allowed',
        `tool ${key} may not see ${input.dataClass} data`,
        undefined,
        key,
      );
    }
    if (
      !(input.transports ?? ADAPTER_TOOL_TRANSPORTS[input.adapter]).includes(tool.transport) ||
      tool.transport !== 'http' ||
      tool.image_digest === null
    ) {
      throw new ToolRegisterError(
        'tool_transport_not_supported',
        `the ${input.adapter} adapter cannot give a run the ${tool.transport} tool ${key}`,
        undefined,
        key,
      );
    }
    const permissions = [...tool.permissions].sort();
    grants.push({
      tool_key: key,
      tool_version: tool.version,
      transport: tool.transport,
      image_digest: tool.image_digest,
      permissions,
      call_rules_sha256: callRulesSha256(permissions),
      backing_services: [...tool.backing_services].sort(),
      max_calls: input.maxCallsPerRun,
    });
    if (
      recertificationStatus(tool.last_recertified_at, input.recertificationMonths, input.now)
        .overdue
    ) {
      overdue.push({ id: tool.id, key });
    }
  }
  return { grants, overdue };
}
