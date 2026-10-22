// Changing the tool register (task X04, design/ADR-M69 §2.2). The same lifecycle as the agent
// register (ADR-M31): a tool belongs to the tenant, is registered `proposed`, becomes `active`
// through approvals (`approvals.ts`), and changes only while `proposed` or `suspended`, with a new
// version. A new image digest is a new version.
//
// The functions take an optional `actor`: the person who acts through the API, or the operator
// (`system`, the default). Who may do what is checked by the callers (`approvals.ts`).
//
// Every change and its audit event are one transaction. Audit payloads hold keys, versions, codes
// and the image digest's hex only: never the image name, the model name or the owner.
import type { ToolStatus, ToolTransport } from '@sdlc/contracts';

import { auditActor, SYSTEM_ACTOR, type AdminActor } from '../admin/actor.js';
import { isCalendarDay, isAgentStatusReason, utcDay } from '../agents/rules.js';
import { DbError } from '../db/errors.js';
import type { ToolUpdate } from '../db/repositories/tools.js';
import type { Tool } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { ToolRegisterError } from './errors.js';
import {
  checkBackingServices,
  checkDataClasses,
  checkImageDigest,
  checkImageRef,
  checkPermissions,
  checkShape,
  checkToolKey,
  checkToolModelRef,
  checkToolVersion,
  checkTransport,
  TOOL_CHANGEABLE_STATUSES,
  TOOL_STATUS_MOVES,
} from './rules.js';

export interface RegisterTool {
  readonly toolKey: string;
  readonly version: string;
  readonly ownerId: string;
  readonly transport: string;
  /** Required for `http`; null for `stdio`. */
  readonly imageRef?: string | null;
  /** `sha256:…`; may be left empty while `proposed`, required to activate an `http` tool. */
  readonly imageDigest?: string | null;
  readonly permissions: readonly string[];
  readonly allowedDataClasses: readonly string[];
  readonly backingServices?: readonly string[];
  readonly modelRef?: string | null;
  readonly now?: Date;
  /** Who acts. Default: the operator (`system`). */
  readonly actor?: AdminActor;
}

/** A new version of the configuration. Left out: unchanged. */
export interface UpdateTool {
  readonly version: string;
  readonly transport?: string;
  readonly imageRef?: string | null;
  readonly imageDigest?: string | null;
  readonly permissions?: readonly string[];
  readonly allowedDataClasses?: readonly string[];
  readonly backingServices?: readonly string[];
  readonly modelRef?: string | null;
  readonly now?: Date;
  readonly actor?: AdminActor;
}

export interface ChangeToolStatus {
  readonly to: ToolStatus;
  /** Required for `suspended`, `quarantined` and `retired`. */
  readonly reason?: string;
  readonly now?: Date;
  readonly actor?: AdminActor;
}

const NEEDS_REASON: readonly ToolStatus[] = ['suspended', 'quarantined', 'retired'];

async function activeOwner(scope: TenantScope, ownerId: string): Promise<string> {
  const owner = await scope.users.getById(ownerId);
  if (owner?.status !== 'active') {
    throw new ToolRegisterError('owner_not_active', 'the owner must be an active user');
  }
  return owner.id;
}

async function lockTool(scope: TenantScope, toolKey: string): Promise<Tool> {
  const tool = await scope.tools.lockByKey(toolKey);
  if (!tool) throw new ToolRegisterError('tool_not_found', `no tool ${toolKey}`);
  if (tool.status === 'retired') {
    throw new ToolRegisterError('tool_retired', `tool ${toolKey} is retired`);
  }
  return tool;
}

const nullable = <T>(value: T | null | undefined, check: (v: T) => T): T | null =>
  value === null || value === undefined ? null : check(value);

/** The hex of a `sha256:` digest, for the audit log (a code of at most 64 characters). */
function digestHex(digest: string | null): { image_sha256?: string } {
  return digest === null ? {} : { image_sha256: digest.slice('sha256:'.length) };
}

function auditPayload(tool: Tool): {
  tool_key: string;
  version: string;
  transport: string;
  image_sha256?: string;
} {
  return {
    tool_key: tool.tool_key,
    version: tool.version,
    transport: tool.transport,
    ...digestHex(tool.image_digest),
  };
}

/** Registers a new tool with status `proposed` and appends `tool.registered`. */
export async function registerTool(scope: TenantScope, input: RegisterTool): Promise<Tool> {
  checkToolKey(input.toolKey);
  checkToolVersion(input.version);
  const transport: ToolTransport = checkTransport(input.transport);
  const fields = {
    transport,
    imageRef: nullable(input.imageRef, checkImageRef),
    imageDigest: nullable(input.imageDigest, checkImageDigest),
    permissions: checkPermissions(input.permissions),
    allowedDataClasses: checkDataClasses(input.allowedDataClasses),
    backingServices: checkBackingServices(input.backingServices ?? []),
    modelRef: nullable(input.modelRef, checkToolModelRef),
  };
  checkShape(fields);
  return scope.transaction(async (tx) => {
    const ownerId = await activeOwner(tx, input.ownerId);
    if (await tx.tools.getByKey(input.toolKey)) {
      throw new ToolRegisterError('tool_exists', `tool key ${input.toolKey} is taken`);
    }
    const tool = await tx.tools
      .create({ toolKey: input.toolKey, version: input.version, ownerId, ...fields })
      .catch((error: unknown) => {
        // Two registrations of the same key at once: the unique index decides.
        if (error instanceof DbError && error.code === 'conflict') {
          throw new ToolRegisterError('tool_exists', `tool key ${input.toolKey} is taken`);
        }
        throw error;
      });
    await tx.audit.append({
      action: 'tool.registered',
      ...auditActor(input.actor ?? SYSTEM_ACTOR),
      entityId: tool.id,
      payload: auditPayload(tool),
    });
    return tool;
  });
}

/**
 * A new version of a tool's configuration. Only while `proposed` or `suspended`, and only with a
 * new version label. Appends `tool.updated`.
 */
export async function updateTool(
  scope: TenantScope,
  toolKey: string,
  input: UpdateTool,
): Promise<Tool> {
  checkToolVersion(input.version);
  const update: ToolUpdate = {
    version: input.version,
    ...(input.transport === undefined ? {} : { transport: checkTransport(input.transport) }),
    ...(input.imageRef === undefined ? {} : { imageRef: nullable(input.imageRef, checkImageRef) }),
    ...(input.imageDigest === undefined
      ? {}
      : { imageDigest: nullable(input.imageDigest, checkImageDigest) }),
    ...(input.permissions === undefined
      ? {}
      : { permissions: checkPermissions(input.permissions) }),
    ...(input.allowedDataClasses === undefined
      ? {}
      : { allowedDataClasses: checkDataClasses(input.allowedDataClasses) }),
    ...(input.backingServices === undefined
      ? {}
      : { backingServices: checkBackingServices(input.backingServices) }),
    ...(input.modelRef === undefined
      ? {}
      : { modelRef: nullable(input.modelRef, checkToolModelRef) }),
  };
  return scope.transaction(async (tx) => {
    const tool = await lockTool(tx, toolKey);
    if (!TOOL_CHANGEABLE_STATUSES.includes(tool.status)) {
      throw new ToolRegisterError(
        'config_change_not_allowed',
        `tool ${toolKey} is ${tool.status}: suspend it before changing it`,
      );
    }
    if (tool.version === input.version) {
      throw new ToolRegisterError('version_unchanged', `tool ${toolKey} needs a new version`);
    }
    checkShape({
      transport: update.transport ?? tool.transport,
      imageRef: update.imageRef === undefined ? tool.image_ref : update.imageRef,
      imageDigest: update.imageDigest === undefined ? tool.image_digest : update.imageDigest,
      backingServices: update.backingServices ?? tool.backing_services,
    });
    const updated = await tx.tools.update(tool.id, update, input.now ?? new Date());
    await tx.audit.append({
      action: 'tool.updated',
      ...auditActor(input.actor ?? SYSTEM_ACTOR),
      entityId: updated.id,
      payload: auditPayload(updated),
    });
    return updated;
  });
}

/**
 * Moves a tool to another status and appends `tool.status_changed`. Activation of an `http` tool
 * needs its image digest; a first activation is also the first certification and appends
 * `tool.recertified`.
 */
export async function changeToolStatus(
  scope: TenantScope,
  toolKey: string,
  input: ChangeToolStatus,
): Promise<Tool> {
  if (input.reason === undefined && NEEDS_REASON.includes(input.to)) {
    throw new ToolRegisterError('reason_required', `moving to ${input.to} needs a reason code`);
  }
  if (input.reason !== undefined && !isAgentStatusReason(input.reason)) {
    throw new ToolRegisterError('invalid_input', 'the reason code is not valid', 'reason_code');
  }
  const reason = input.reason;
  const now = input.now ?? new Date();
  return scope.transaction(async (tx) => {
    const tool = await lockTool(tx, toolKey);
    if (!TOOL_STATUS_MOVES[tool.status].includes(input.to)) {
      throw new ToolRegisterError(
        'status_move_not_allowed',
        `tool ${toolKey}: ${tool.status} cannot become ${input.to}`,
      );
    }
    if (input.to === 'active' && tool.transport === 'http' && tool.image_digest === null) {
      throw new ToolRegisterError('image_not_pinned', `tool ${toolKey} has no image digest`);
    }
    const certify = input.to === 'active' && tool.last_recertified_at === null;
    const updated = await tx.tools.update(
      tool.id,
      { status: input.to, ...(certify ? { lastRecertifiedAt: utcDay(now) } : {}) },
      now,
    );
    const actor = input.actor ?? SYSTEM_ACTOR;
    await tx.audit.append({
      action: 'tool.status_changed',
      ...auditActor(actor),
      entityId: updated.id,
      payload: {
        tool_key: updated.tool_key,
        from: tool.status,
        to: updated.status,
        ...(reason === undefined ? {} : { reason_code: reason }),
      },
    });
    if (certify) await appendRecertified(tx, updated, actor);
    return updated;
  });
}

/** Gives a tool a new owner. */
export async function changeToolOwner(
  scope: TenantScope,
  toolKey: string,
  ownerId: string,
  now: Date = new Date(),
  actor: AdminActor = SYSTEM_ACTOR,
): Promise<Tool> {
  return scope.transaction(async (tx) => {
    const tool = await lockTool(tx, toolKey);
    const owner = await activeOwner(tx, ownerId);
    if (owner === tool.owner_id) return tool;
    const updated = await tx.tools.update(tool.id, { ownerId: owner }, now);
    await tx.audit.append({
      action: 'tool.owner_changed',
      ...auditActor(actor),
      entityId: updated.id,
      payload: { tool_key: updated.tool_key },
    });
    return updated;
  });
}

/**
 * Records a recertification on `day` (`YYYY-MM-DD`, default today in UTC). The day may not be in
 * the future or before the last recertification. Appends `tool.recertified`.
 */
export async function recertifyTool(
  scope: TenantScope,
  toolKey: string,
  input: { readonly day?: string; readonly now?: Date; readonly actor?: AdminActor } = {},
): Promise<Tool> {
  const now = input.now ?? new Date();
  const day = input.day ?? utcDay(now);
  if (!isCalendarDay(day) || day > utcDay(now)) {
    throw new ToolRegisterError('recertification_date_invalid', `day ${day} is not valid`);
  }
  return scope.transaction(async (tx) => {
    const tool = await lockTool(tx, toolKey);
    if (tool.last_recertified_at !== null && day < tool.last_recertified_at) {
      throw new ToolRegisterError(
        'recertification_date_invalid',
        `day ${day} is before the last recertification`,
      );
    }
    const updated = await tx.tools.update(tool.id, { lastRecertifiedAt: day }, now);
    await appendRecertified(tx, updated, input.actor ?? SYSTEM_ACTOR);
    return updated;
  });
}

async function appendRecertified(scope: TenantScope, tool: Tool, actor: AdminActor): Promise<void> {
  await scope.audit.append({
    action: 'tool.recertified',
    ...auditActor(actor),
    entityId: tool.id,
    payload: { tool_key: tool.tool_key },
  });
}
