// The tool register (design/D-05 section 6.1, D-08 X04, design/ADR-M69 §2.2). Codes only. Rows are
// never deleted; the checks and the audit events live in `tools/` (core), which calls this.
import type { DataClass, ToolPermission, ToolStatus, ToolTransport } from '@sdlc/contracts';

import { sql } from 'kysely';

import type { Tool } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

// `pg` does not parse arrays of custom enum types; read `allowed_data_classes` as text[].
const COLUMNS = [
  'id',
  'tenant_id',
  'tool_key',
  'version',
  'status',
  'owner_id',
  'transport',
  'image_ref',
  'image_digest',
  'permissions',
  sql<DataClass[]>`allowed_data_classes::text[]`.as('allowed_data_classes'),
  'backing_services',
  'model_ref',
  'last_recertified_at',
  'updated_at',
  'created_at',
] as const;

export interface NewTool {
  readonly toolKey: string;
  readonly version: string;
  readonly ownerId: string;
  readonly transport: ToolTransport;
  readonly imageRef: string | null;
  readonly imageDigest: string | null;
  readonly permissions: readonly ToolPermission[];
  readonly allowedDataClasses: readonly DataClass[];
  readonly backingServices: readonly string[];
  readonly modelRef: string | null;
}

/** Columns a change may set. Left out: unchanged. The trigger decides what is allowed. */
export interface ToolUpdate {
  readonly version?: string;
  readonly status?: ToolStatus;
  readonly ownerId?: string;
  readonly transport?: ToolTransport;
  readonly imageRef?: string | null;
  readonly imageDigest?: string | null;
  readonly permissions?: readonly ToolPermission[];
  readonly allowedDataClasses?: readonly DataClass[];
  readonly backingServices?: readonly string[];
  readonly modelRef?: string | null;
  /** `YYYY-MM-DD`. */
  readonly lastRecertifiedAt?: string;
}

export interface ToolQuery {
  readonly statuses?: readonly ToolStatus[];
}

export class ToolRepository extends TenantRepository {
  create(input: NewTool): Promise<Tool> {
    return this.run(
      this.db
        .insertInto('tools')
        .values({
          tenant_id: this.tenantId,
          tool_key: input.toolKey,
          version: input.version,
          owner_id: input.ownerId,
          transport: input.transport,
          image_ref: input.imageRef,
          image_digest: input.imageDigest,
          permissions: [...input.permissions],
          allowed_data_classes: [...input.allowedDataClasses],
          backing_services: [...input.backingServices],
          model_ref: input.modelRef,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string): Promise<Tool | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('tools')
        .select(COLUMNS)
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  getByKey(toolKey: string): Promise<Tool | undefined> {
    return this.run(
      this.db
        .selectFrom('tools')
        .select(COLUMNS)
        .where('tenant_id', '=', this.tenantId)
        .where('tool_key', '=', toolKey)
        .executeTakeFirst(),
    );
  }

  /** The tools with these keys, in one query (G4, the evaluation fingerprint). */
  listByKeys(toolKeys: readonly string[]): Promise<Tool[]> {
    if (toolKeys.length === 0) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('tools')
        .select(COLUMNS)
        .where('tenant_id', '=', this.tenantId)
        .where('tool_key', 'in', [...toolKeys])
        .orderBy('tool_key')
        .execute(),
    );
  }

  /** Locks the row until the transaction ends, so two changes never interleave. */
  lockByKey(toolKey: string): Promise<Tool | undefined> {
    return this.run(
      this.db
        .selectFrom('tools')
        .select(COLUMNS)
        .where('tenant_id', '=', this.tenantId)
        .where('tool_key', '=', toolKey)
        .forUpdate()
        .executeTakeFirst(),
    );
  }

  list(query: ToolQuery = {}): Promise<Tool[]> {
    let select = this.db.selectFrom('tools').select(COLUMNS).where('tenant_id', '=', this.tenantId);
    if (query.statuses !== undefined) {
      if (query.statuses.length === 0) return Promise.resolve([]);
      select = select.where('status', 'in', [...query.statuses]);
    }
    return this.run(select.orderBy('tool_key').execute());
  }

  update(id: string, update: ToolUpdate, at: Date): Promise<Tool> {
    const set = {
      ...(update.version === undefined ? {} : { version: update.version }),
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.ownerId === undefined ? {} : { owner_id: update.ownerId }),
      ...(update.transport === undefined ? {} : { transport: update.transport }),
      ...(update.imageRef === undefined ? {} : { image_ref: update.imageRef }),
      ...(update.imageDigest === undefined ? {} : { image_digest: update.imageDigest }),
      ...(update.permissions === undefined ? {} : { permissions: [...update.permissions] }),
      ...(update.allowedDataClasses === undefined
        ? {}
        : { allowed_data_classes: [...update.allowedDataClasses] }),
      ...(update.backingServices === undefined
        ? {}
        : { backing_services: [...update.backingServices] }),
      ...(update.modelRef === undefined ? {} : { model_ref: update.modelRef }),
      ...(update.lastRecertifiedAt === undefined
        ? {}
        : { last_recertified_at: update.lastRecertifiedAt }),
    };
    return this.run(
      this.db
        .updateTable('tools')
        .set({ ...set, updated_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow(),
    );
  }
}
