// Response bodies of the tool register endpoints (task X04, ADR-M69 §2.2). Codes, IDs, digests and
// dates only, like the register itself.
import {
  recertificationStatus,
  toolApprovers,
  type Tool,
  type ToolApproval,
  type ToolRound,
} from '@sdlc/core';

export function presentTool(tool: Tool, months: number, now: Date): Record<string, unknown> {
  const recert = recertificationStatus(tool.last_recertified_at, months, now);
  return {
    id: tool.id,
    key: tool.tool_key,
    code: `tool:${tool.tool_key}`,
    version: tool.version,
    status: tool.status,
    owner_id: tool.owner_id,
    transport: tool.transport,
    image_ref: tool.image_ref,
    image_digest: tool.image_digest,
    permissions: tool.permissions,
    allowed_data_classes: tool.allowed_data_classes,
    backing_services: tool.backing_services,
    model_ref: tool.model_ref,
    last_recertified_at: tool.last_recertified_at,
    recertification_due_on: recert.dueOn,
    // Only a tool that may run needs a current certification.
    overdue: tool.status === 'active' && recert.overdue,
    updated_at: tool.updated_at.toISOString(),
  };
}

export function presentToolApproval(approval: ToolApproval): Record<string, unknown> {
  return {
    id: approval.id,
    tool_version: approval.tool_version,
    purpose: approval.purpose,
    capacity: approval.capacity,
    approver_id: approval.approver_id,
    created_at: approval.created_at.toISOString(),
  };
}

/** The approvals of a step so far, the sets that complete it, and the tool. */
export function presentToolRound(
  round: ToolRound & { readonly completed?: boolean },
  months: number,
  now: Date,
): Record<string, unknown> {
  const given = new Set(round.approvals.map((approval) => approval.capacity));
  return {
    tool: presentTool(round.tool, months, now),
    purpose: round.purpose,
    // Any one set completes the step, each capacity by a different person.
    sets: round.sets,
    approvers: toolApprovers(round.purpose),
    missing: round.sets.map((set) => set.filter((capacity) => !given.has(capacity))),
    approvals: round.approvals.map(presentToolApproval),
    ...(round.completed === undefined ? {} : { completed: round.completed }),
  };
}
