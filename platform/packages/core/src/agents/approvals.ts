// The agent register through the API (task B13 AC7, handbook Ch.20, ADR-M37 §2.8): who may
// register, change, approve, stop, hand over and recertify an agent. Approver capacities come
// from `approval-rules.ts` (a time-limited exception to "rules in configuration", QUESTIONS #153).
//
// - Register: a tenant admin (who names the technical owner).
// - A new version: the owner or a tenant admin; the agent must be `proposed` or `suspended`.
// - Activate: only through approvals. When every capacity required for the agent's state has
//   approved, each by a different person, the agent becomes `active` in the same transaction.
// - Retire: through approvals too (owner + leadership).
// - Suspend, quarantine: one person, Person B or leadership, at any time (§20.9).
// - Owner: a tenant admin. Recertify: the owner.

import { isTenantAdmin, type AdminActor } from '../admin/actor.js';
import { DbError } from '../db/errors.js';
import type { Agent, AgentApproval } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import {
  APPROVAL_CAPACITIES,
  requiredApprovers,
  STOP_CAPACITIES,
  type ApprovalCapacity,
  type ApprovalPurpose,
} from './approval-rules.js';
import { AgentRegisterError } from './errors.js';
import {
  changeAgentOwner,
  changeAgentStatus,
  recertifyAgent,
  registerAgent,
  updateAgent,
  type RegisterAgent,
  type UpdateAgent,
} from './register.js';
import { AGENT_STATUS_MOVES } from './rules.js';

type Person = AdminActor & { readonly type: 'human' };

/** True when the person fills the capacity for this agent (QUESTIONS #153). */
export async function holdsCapacity(
  scope: TenantScope,
  userId: string,
  capacity: ApprovalCapacity,
  agent: Pick<Agent, 'owner_id'>,
): Promise<boolean> {
  if (capacity === 'owner') return agent.owner_id === userId;
  const user = await scope.users.getById(userId);
  if (user?.status !== 'active') return false;
  const projects = new Map((await scope.projects.list()).map((p) => [p.id, p.status]));
  return (await scope.roleBindings.listForUser(userId)).some(
    (binding) => binding.role === capacity && projects.get(binding.project_id) === 'active',
  );
}

async function findAgent(scope: TenantScope, agentKey: string): Promise<Agent> {
  const agent = await scope.agents.getByKey(agentKey);
  if (!agent) throw new AgentRegisterError('agent_not_found', `no agent ${agentKey}`);
  return agent;
}

function notPermitted(what: string): AgentRegisterError {
  return new AgentRegisterError('not_permitted', `the actor may not ${what}`);
}

export async function registerAgentAs(
  scope: TenantScope,
  actor: Person,
  input: Omit<RegisterAgent, 'actor'>,
): Promise<Agent> {
  return scope.transaction(async (tx) => {
    if (!(await isTenantAdmin(tx, actor.userId))) throw notPermitted('register an agent');
    return registerAgent(tx, { ...input, actor });
  });
}

export async function updateAgentAs(
  scope: TenantScope,
  actor: Person,
  agentKey: string,
  input: Omit<UpdateAgent, 'actor'>,
): Promise<Agent> {
  return scope.transaction(async (tx) => {
    const agent = await findAgent(tx, agentKey);
    if (agent.owner_id !== actor.userId && !(await isTenantAdmin(tx, actor.userId))) {
      throw notPermitted('change the agent');
    }
    return updateAgent(tx, agentKey, { ...input, actor });
  });
}

export async function changeOwnerAs(
  scope: TenantScope,
  actor: Person,
  agentKey: string,
  ownerId: string,
  now?: Date,
): Promise<Agent> {
  return scope.transaction(async (tx) => {
    if (!(await isTenantAdmin(tx, actor.userId))) throw notPermitted('change the owner');
    return changeAgentOwner(tx, agentKey, ownerId, now, actor);
  });
}

export async function recertifyAgentAs(
  scope: TenantScope,
  actor: Person,
  agentKey: string,
  input: { readonly day?: string; readonly now?: Date } = {},
): Promise<Agent> {
  return scope.transaction(async (tx) => {
    const agent = await findAgent(tx, agentKey);
    if (agent.owner_id !== actor.userId) throw notPermitted('recertify the agent');
    return recertifyAgent(tx, agentKey, { ...input, actor });
  });
}

/** Suspend or quarantine: Person B or leadership, at any time (Ch.20 §20.9). */
export async function stopAgentAs(
  scope: TenantScope,
  actor: Person,
  agentKey: string,
  to: 'suspended' | 'quarantined',
  reason: string,
  now?: Date,
): Promise<Agent> {
  return scope.transaction(async (tx) => {
    const agent = await findAgent(tx, agentKey);
    const allowed = await Promise.all(
      STOP_CAPACITIES.map((capacity) => holdsCapacity(tx, actor.userId, capacity, agent)),
    );
    if (!allowed.some(Boolean)) throw notPermitted(`move the agent to ${to}`);
    return changeAgentStatus(tx, agentKey, {
      to,
      reason,
      actor,
      ...(now === undefined ? {} : { now }),
    });
  });
}

export interface AgentRound {
  readonly agent: Agent;
  readonly purpose: ApprovalPurpose;
  /** Capacities that must each approve, by a different person. */
  readonly required: readonly ApprovalCapacity[];
  /** Approvals of the agent as it is now (its version and its last change). */
  readonly approvals: readonly AgentApproval[];
}

/** The approvals so far of the agent as it is now, for a purpose. */
export async function agentRound(
  scope: TenantScope,
  agentKey: string,
  purpose: ApprovalPurpose,
): Promise<AgentRound> {
  const agent = await findAgent(scope, agentKey);
  return {
    agent,
    purpose,
    required: requiredApprovers(purpose, {
      status: agent.status,
      max_autonomy: agent.max_autonomy,
    }),
    approvals: await scope.agentApprovals.listForRound(agent.id, purpose, agent.updated_at),
  };
}

export interface ApproveAgent {
  readonly purpose: ApprovalPurpose;
  /** The capacity the person approves in. */
  readonly capacity: ApprovalCapacity;
  /** Required to retire: the reason code (ADR-M31 §2.3), used when the set completes. */
  readonly reason?: string;
  readonly now?: Date;
}

export interface ApprovalResult extends AgentRound {
  /** True when this approval completed the set and the agent changed status. */
  readonly completed: boolean;
}

/**
 * Records one approval. When every required capacity has approved, the agent becomes `active`
 * (purpose `activate`) or `retired` (purpose `retire`) in the same transaction, with the last
 * approver as actor. An approval counts only for the agent as it is now: any change of the agent
 * starts a new round.
 */
export async function approveAgent(
  scope: TenantScope,
  actor: Person,
  agentKey: string,
  input: ApproveAgent,
): Promise<ApprovalResult> {
  if (!(APPROVAL_CAPACITIES as readonly string[]).includes(input.capacity)) {
    throw new AgentRegisterError('invalid_input', 'unknown capacity', 'capacity');
  }
  if (input.purpose === 'retire' && input.reason === undefined) {
    throw new AgentRegisterError('reason_required', 'retiring needs a reason code');
  }
  return scope.transaction(async (tx) => {
    const locked = await tx.agents.lockByKey(agentKey);
    if (!locked) throw new AgentRegisterError('agent_not_found', `no agent ${agentKey}`);
    const target = input.purpose === 'activate' ? 'active' : 'retired';
    if (!AGENT_STATUS_MOVES[locked.status].includes(target)) {
      throw new AgentRegisterError(
        'status_move_not_allowed',
        `agent ${agentKey}: ${locked.status} cannot become ${target}`,
      );
    }
    if (target === 'active' && locked.model_ref === null) {
      throw new AgentRegisterError('model_not_pinned', `agent ${agentKey} has no pinned model`);
    }
    const round = await agentRound(tx, agentKey, input.purpose);
    if (!round.required.includes(input.capacity)) {
      throw new AgentRegisterError('not_an_approver', `${input.capacity} does not approve this`);
    }
    if (!(await holdsCapacity(tx, actor.userId, input.capacity, locked))) {
      throw new AgentRegisterError('not_an_approver', `the actor is not ${input.capacity}`);
    }
    if (round.approvals.some((approval) => approval.approver_id === actor.userId)) {
      throw new AgentRegisterError('approval_duplicate', 'the person already approved');
    }
    if (round.approvals.some((approval) => approval.capacity === input.capacity)) {
      throw new AgentRegisterError('approval_duplicate', `${input.capacity} already approved`);
    }
    const approval = await tx.agentApprovals
      .record({
        agent_id: locked.id,
        agent_version: locked.version,
        purpose: input.purpose,
        capacity: input.capacity,
        approver_id: actor.userId,
        round_at: locked.updated_at,
      })
      .catch((error: unknown) => {
        throw error instanceof DbError && error.code === 'conflict'
          ? new AgentRegisterError('approval_duplicate', 'already approved this round')
          : error;
      });
    await tx.audit.append({
      action: 'agent.approval_recorded',
      actorType: 'human',
      actorId: actor.userId,
      entityId: locked.id,
      payload: {
        agent_key: locked.agent_key,
        version: locked.version,
        purpose: input.purpose,
        capacity: input.capacity,
      },
    });
    const approvals = [...round.approvals, approval];
    const covered = new Set(approvals.map((a) => a.capacity));
    if (!round.required.every((capacity) => covered.has(capacity))) {
      return { ...round, approvals, completed: false };
    }
    const agent = await changeAgentStatus(tx, agentKey, {
      to: target,
      actor,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return { ...round, agent, approvals, completed: true };
  });
}
