// Response bodies of the agent register endpoints (task B13 AC7). Codes, IDs, hashes and dates
// only, like the register itself (ADR-M31 §2.1).
import { recertificationStatus, type Agent, type AgentApproval, type AgentRound } from '@sdlc/core';

export function presentAgent(agent: Agent, months: number, now: Date): Record<string, unknown> {
  const recert = recertificationStatus(agent.last_recertified_at, months, now);
  return {
    id: agent.id,
    key: agent.agent_key,
    version: agent.version,
    status: agent.status,
    owner_id: agent.owner_id,
    model_ref: agent.model_ref,
    instructions_ref: agent.instructions_ref,
    instructions_sha256: agent.instructions_sha256,
    allowed_tools: agent.allowed_tools,
    max_autonomy: agent.max_autonomy,
    approved_environments: agent.approved_environments,
    last_recertified_at: agent.last_recertified_at,
    recertification_due_on: recert.dueOn,
    // Only an agent that may run needs a current certification.
    overdue: agent.status === 'active' && recert.overdue,
    updated_at: agent.updated_at.toISOString(),
  };
}

export function presentApproval(approval: AgentApproval): Record<string, unknown> {
  return {
    id: approval.id,
    agent_version: approval.agent_version,
    purpose: approval.purpose,
    capacity: approval.capacity,
    approver_id: approval.approver_id,
    created_at: approval.created_at.toISOString(),
  };
}

/** The approvals of a step so far, what it still needs, and the agent. */
export function presentRound(
  round: AgentRound & { readonly completed?: boolean },
  months: number,
  now: Date,
): Record<string, unknown> {
  const given = new Set(round.approvals.map((approval) => approval.capacity));
  return {
    agent: presentAgent(round.agent, months, now),
    purpose: round.purpose,
    required: round.required,
    missing: round.required.filter((capacity) => !given.has(capacity)),
    approvals: round.approvals.map(presentApproval),
    completed: round.completed ?? false,
  };
}
