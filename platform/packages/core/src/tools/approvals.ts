// The tool register through the API (task X04, design/ADR-M69 §2.2; handbook Ch.20 applies to tools
// the same way as to agents): who may register, change, approve, stop, hand over and recertify a
// tool. Capacities are those of the agent register (`agents/approval-rules.ts`, QUESTIONS #153):
// a person fills `person_a`, `person_b` or `governance` when they hold the role on an active
// project of the tenant; `owner` is the tool's owner.
//
// - Register: a tenant admin (who names the technical owner).
// - A new version: the owner or a tenant admin; the tool must be `proposed` or `suspended`.
// - Activate: the owner and Person B, or the owner and governance (ADR-M69 §2.2). When the set is
//   complete, each capacity by a different person, the tool becomes `active` in the same
//   transaction.
// - Retire: the owner and governance.
// - Suspend, quarantine: one person, Person B or governance, at any time.
// - Owner: a tenant admin. Recertify: the owner.
import { isTenantAdmin, type AdminActor } from '../admin/actor.js';
import {
  APPROVAL_CAPACITIES,
  STOP_CAPACITIES,
  type ApprovalCapacity,
  type ApprovalPurpose,
} from '../agents/approval-rules.js';
import { holdsCapacity } from '../agents/approvals.js';
import { DbError } from '../db/errors.js';
import type { Tool, ToolApproval } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { ToolRegisterError } from './errors.js';
import {
  changeToolOwner,
  changeToolStatus,
  recertifyTool,
  registerTool,
  updateTool,
  type RegisterTool,
  type UpdateTool,
} from './register.js';
import { TOOL_STATUS_MOVES } from './rules.js';

type Person = AdminActor & { readonly type: 'human' };

/**
 * The sets of capacities that complete a round: any one set, each capacity by a different person
 * (ADR-M69 §2.2: the owner and Person B, or governance; retirement: the owner and governance).
 */
export const TOOL_APPROVER_SETS: Readonly<
  Record<ApprovalPurpose, readonly (readonly ApprovalCapacity[])[]>
> = {
  activate: [
    ['owner', 'person_b'],
    ['owner', 'governance'],
  ],
  retire: [['owner', 'governance']],
};

/** The capacities that may approve a purpose: those of any set. */
export function toolApprovers(purpose: ApprovalPurpose): readonly ApprovalCapacity[] {
  return [...new Set(TOOL_APPROVER_SETS[purpose].flat())];
}

async function findTool(scope: TenantScope, toolKey: string): Promise<Tool> {
  const tool = await scope.tools.getByKey(toolKey);
  if (!tool) throw new ToolRegisterError('tool_not_found', `no tool ${toolKey}`);
  return tool;
}

function notPermitted(what: string): ToolRegisterError {
  return new ToolRegisterError('not_permitted', `the actor may not ${what}`);
}

export async function registerToolAs(
  scope: TenantScope,
  actor: Person,
  input: Omit<RegisterTool, 'actor'>,
): Promise<Tool> {
  return scope.transaction(async (tx) => {
    if (!(await isTenantAdmin(tx, actor.userId))) throw notPermitted('register a tool');
    return registerTool(tx, { ...input, actor });
  });
}

export async function updateToolAs(
  scope: TenantScope,
  actor: Person,
  toolKey: string,
  input: Omit<UpdateTool, 'actor'>,
): Promise<Tool> {
  return scope.transaction(async (tx) => {
    const tool = await findTool(tx, toolKey);
    if (tool.owner_id !== actor.userId && !(await isTenantAdmin(tx, actor.userId))) {
      throw notPermitted('change the tool');
    }
    return updateTool(tx, toolKey, { ...input, actor });
  });
}

export async function changeToolOwnerAs(
  scope: TenantScope,
  actor: Person,
  toolKey: string,
  ownerId: string,
  now?: Date,
): Promise<Tool> {
  return scope.transaction(async (tx) => {
    if (!(await isTenantAdmin(tx, actor.userId))) throw notPermitted('change the owner');
    return changeToolOwner(tx, toolKey, ownerId, now, actor);
  });
}

export async function recertifyToolAs(
  scope: TenantScope,
  actor: Person,
  toolKey: string,
  input: { readonly day?: string; readonly now?: Date } = {},
): Promise<Tool> {
  return scope.transaction(async (tx) => {
    const tool = await findTool(tx, toolKey);
    if (tool.owner_id !== actor.userId) throw notPermitted('recertify the tool');
    return recertifyTool(tx, toolKey, { ...input, actor });
  });
}

/** Suspend or quarantine: Person B or governance, at any time. */
export async function stopToolAs(
  scope: TenantScope,
  actor: Person,
  toolKey: string,
  to: 'suspended' | 'quarantined',
  reason: string,
  now?: Date,
): Promise<Tool> {
  return scope.transaction(async (tx) => {
    const tool = await findTool(tx, toolKey);
    const allowed = await Promise.all(
      STOP_CAPACITIES.map((capacity) => holdsCapacity(tx, actor.userId, capacity, tool)),
    );
    if (!allowed.some(Boolean)) throw notPermitted(`move the tool to ${to}`);
    return changeToolStatus(tx, toolKey, {
      to,
      reason,
      actor,
      ...(now === undefined ? {} : { now }),
    });
  });
}

export interface ToolRound {
  readonly tool: Tool;
  readonly purpose: ApprovalPurpose;
  /** Sets of capacities: any one set completes the round. */
  readonly sets: readonly (readonly ApprovalCapacity[])[];
  /** Approvals of the tool as it is now (its version and its last change). */
  readonly approvals: readonly ToolApproval[];
}

/** The approvals so far of the tool as it is now, for a purpose. */
export async function toolRound(
  scope: TenantScope,
  toolKey: string,
  purpose: ApprovalPurpose,
): Promise<ToolRound> {
  const tool = await findTool(scope, toolKey);
  return {
    tool,
    purpose,
    sets: TOOL_APPROVER_SETS[purpose],
    approvals: await scope.toolApprovals.listForRound(tool.id, purpose, tool.updated_at),
  };
}

export interface ApproveTool {
  readonly purpose: ApprovalPurpose;
  readonly capacity: ApprovalCapacity;
  /** Required to retire: the reason code, used when the set completes. */
  readonly reason?: string;
  readonly now?: Date;
}

export interface ToolApprovalResult extends ToolRound {
  /** True when this approval completed a set and the tool changed status. */
  readonly completed: boolean;
}

/**
 * Records one approval. When the approvals cover one set, the tool becomes `active` (purpose
 * `activate`) or `retired` (purpose `retire`) in the same transaction, with the last approver as
 * actor. An approval counts only for the tool as it is now: any change starts a new round.
 */
export async function approveTool(
  scope: TenantScope,
  actor: Person,
  toolKey: string,
  input: ApproveTool,
): Promise<ToolApprovalResult> {
  if (!(APPROVAL_CAPACITIES as readonly string[]).includes(input.capacity)) {
    throw new ToolRegisterError('invalid_input', 'unknown capacity', 'capacity');
  }
  if (input.purpose === 'retire' && input.reason === undefined) {
    throw new ToolRegisterError('reason_required', 'retiring needs a reason code');
  }
  return scope.transaction(async (tx) => {
    const locked = await tx.tools.lockByKey(toolKey);
    if (!locked) throw new ToolRegisterError('tool_not_found', `no tool ${toolKey}`);
    const target = input.purpose === 'activate' ? 'active' : 'retired';
    if (!TOOL_STATUS_MOVES[locked.status].includes(target)) {
      throw new ToolRegisterError(
        'status_move_not_allowed',
        `tool ${toolKey}: ${locked.status} cannot become ${target}`,
      );
    }
    if (target === 'active' && locked.transport === 'http' && locked.image_digest === null) {
      throw new ToolRegisterError('image_not_pinned', `tool ${toolKey} has no image digest`);
    }
    const round = await toolRound(tx, toolKey, input.purpose);
    if (!toolApprovers(input.purpose).includes(input.capacity)) {
      throw new ToolRegisterError('not_an_approver', `${input.capacity} does not approve this`);
    }
    if (!(await holdsCapacity(tx, actor.userId, input.capacity, locked))) {
      throw new ToolRegisterError('not_an_approver', `the actor is not ${input.capacity}`);
    }
    if (round.approvals.some((approval) => approval.approver_id === actor.userId)) {
      throw new ToolRegisterError('approval_duplicate', 'the person already approved');
    }
    if (round.approvals.some((approval) => approval.capacity === input.capacity)) {
      throw new ToolRegisterError('approval_duplicate', `${input.capacity} already approved`);
    }
    const approval = await tx.toolApprovals
      .record({
        tool_id: locked.id,
        tool_version: locked.version,
        purpose: input.purpose,
        capacity: input.capacity,
        approver_id: actor.userId,
        round_at: locked.updated_at,
      })
      .catch((error: unknown) => {
        throw error instanceof DbError && error.code === 'conflict'
          ? new ToolRegisterError('approval_duplicate', 'already approved this round')
          : error;
      });
    await tx.audit.append({
      action: 'tool.approval_recorded',
      actorType: 'human',
      actorId: actor.userId,
      entityId: locked.id,
      payload: {
        tool_key: locked.tool_key,
        version: locked.version,
        purpose: input.purpose,
        capacity: input.capacity,
      },
    });
    const approvals = [...round.approvals, approval];
    const covered = new Set(approvals.map((a) => a.capacity));
    if (!round.sets.some((set) => set.every((capacity) => covered.has(capacity)))) {
      return { ...round, approvals, completed: false };
    }
    const tool = await changeToolStatus(tx, toolKey, {
      to: target,
      actor,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return { ...round, tool, approvals, completed: true };
  });
}
