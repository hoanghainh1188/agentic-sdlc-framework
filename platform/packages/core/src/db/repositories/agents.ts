// The agent register (design/D-05 section 6.1, D-08 C10, design/ADR-M31). Codes only. Rows are
// never deleted; the checks and the audit events live in `agents/` (core), which calls this.
import type { AgentStatus, AutonomyLevel } from '@sdlc/contracts';

import type { Agent } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import type { AgentEnvironment } from '../vocabulary.js';
import { TenantRepository } from './base.js';

export interface NewAgent {
  readonly agentKey: string;
  readonly version: string;
  readonly ownerId: string;
  readonly modelRef: string | null;
  readonly instructionsRef: string;
  readonly instructionsSha256: string;
  readonly allowedTools: readonly string[];
  readonly maxAutonomy: AutonomyLevel;
  readonly approvedEnvironments: readonly AgentEnvironment[];
}

/** Columns a change may set. Left out: unchanged. The trigger decides what is allowed. */
export interface AgentUpdate {
  readonly version?: string;
  readonly status?: AgentStatus;
  readonly ownerId?: string;
  readonly modelRef?: string | null;
  readonly instructionsRef?: string;
  readonly instructionsSha256?: string;
  readonly allowedTools?: readonly string[];
  readonly maxAutonomy?: AutonomyLevel;
  readonly approvedEnvironments?: readonly AgentEnvironment[];
  /** `YYYY-MM-DD`. */
  readonly lastRecertifiedAt?: string;
}

export interface AgentQuery {
  readonly statuses?: readonly AgentStatus[];
}

export class AgentRepository extends TenantRepository {
  create(input: NewAgent): Promise<Agent> {
    return this.run(
      this.db
        .insertInto('agents')
        .values({
          tenant_id: this.tenantId,
          agent_key: input.agentKey,
          version: input.version,
          owner_id: input.ownerId,
          model_ref: input.modelRef,
          instructions_ref: input.instructionsRef,
          instructions_sha256: input.instructionsSha256,
          allowed_tools: [...input.allowedTools],
          max_autonomy: input.maxAutonomy,
          approved_environments: [...input.approvedEnvironments],
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string): Promise<Agent | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('agents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  getByKey(agentKey: string): Promise<Agent | undefined> {
    return this.run(
      this.db
        .selectFrom('agents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('agent_key', '=', agentKey)
        .executeTakeFirst(),
    );
  }

  /** Locks the row until the transaction ends, so two changes never interleave. */
  lockByKey(agentKey: string): Promise<Agent | undefined> {
    return this.run(
      this.db
        .selectFrom('agents')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('agent_key', '=', agentKey)
        .forUpdate()
        .executeTakeFirst(),
    );
  }

  list(query: AgentQuery = {}): Promise<Agent[]> {
    let select = this.db.selectFrom('agents').selectAll().where('tenant_id', '=', this.tenantId);
    if (query.statuses !== undefined) {
      if (query.statuses.length === 0) return Promise.resolve([]);
      select = select.where('status', 'in', [...query.statuses]);
    }
    return this.run(select.orderBy('agent_key').execute());
  }

  update(id: string, update: AgentUpdate, at: Date): Promise<Agent> {
    const set = {
      ...(update.version === undefined ? {} : { version: update.version }),
      ...(update.status === undefined ? {} : { status: update.status }),
      ...(update.ownerId === undefined ? {} : { owner_id: update.ownerId }),
      ...(update.modelRef === undefined ? {} : { model_ref: update.modelRef }),
      ...(update.instructionsRef === undefined ? {} : { instructions_ref: update.instructionsRef }),
      ...(update.instructionsSha256 === undefined
        ? {}
        : { instructions_sha256: update.instructionsSha256 }),
      ...(update.allowedTools === undefined ? {} : { allowed_tools: [...update.allowedTools] }),
      ...(update.maxAutonomy === undefined ? {} : { max_autonomy: update.maxAutonomy }),
      ...(update.approvedEnvironments === undefined
        ? {}
        : { approved_environments: [...update.approvedEnvironments] }),
      ...(update.lastRecertifiedAt === undefined
        ? {}
        : { last_recertified_at: update.lastRecertifiedAt }),
    };
    return this.run(
      this.db
        .updateTable('agents')
        .set({ ...set, updated_at: at })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }
}
