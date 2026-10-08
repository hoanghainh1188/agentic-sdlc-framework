// Specs linked to an intent (design/D-05 section 6.2, D-02 FR-02). One row per version; rows never
// change. Fetching the content from the Git host and re-checking the hash: `specs/` (B08, ADR-M39).
import { sql } from 'kysely';

import { RegistryError } from '../../registry/errors.js';
import { DbError } from '../errors.js';
import type { SpecRef } from '../schema.js';
import {
  ACCEPTANCE_CRITERIA_MAX,
  SPEC_SOURCE_TOOLS,
  SPEC_STRUCTURES,
  type SpecSourceTool,
  type SpecStructureCode,
} from '../vocabulary.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { lockIntent } from './locks.js';
import type { RegistryActor } from './registry-actor.js';

export interface LinkSpec extends RegistryActor {
  /** File path in the repo, relative, without `.` or `..` segments. */
  readonly path: string;
  readonly commitSha: string;
  readonly contentSha256: string;
  readonly sourceTool?: SpecSourceTool | null;
  /**
   * Why the spec is linked (B08, ADR-M39): `linked` (a person, the default) or `head_changed`
   * (the workflow follows a change of the file at the head of the default branch).
   */
  readonly cause?: 'linked' | 'head_changed';
  /**
   * S01 (ADR-M61): the structure rule that matched and the acceptance criteria it found
   * (`readSpecStructure`, read with the content hash). Required: every new version has a count.
   */
  readonly structure: SpecStructureCode;
  readonly acceptanceCriteria: number;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** A safe relative path: no leading slash, no backslash, no `.` or `..` segment, no NUL. */
export function isSafeRepoPath(path: string): boolean {
  return (
    path.length >= 1 &&
    path.length <= 1024 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

export class SpecRefRepository extends TenantRepository {
  /**
   * Links a new spec version (latest + 1) to the intent. In the same transaction, appends
   * `spec.linked` with the version and content hash (never the path or the content).
   */
  async link(intentId: string, input: LinkSpec): Promise<SpecRef> {
    if (!isSafeRepoPath(input.path)) throw invalid('path must be a safe relative path');
    if (!COMMIT_SHA.test(input.commitSha)) throw invalid('commitSha must be a 40-hex commit SHA');
    if (!SHA256.test(input.contentSha256)) throw invalid('contentSha256 must be a SHA-256 digest');
    const tool = input.sourceTool ?? null;
    if (tool !== null && !SPEC_SOURCE_TOOLS.includes(tool)) throw invalid('unknown source tool');
    if (!SPEC_STRUCTURES.includes(input.structure)) throw invalid('unknown spec structure');
    const count = input.acceptanceCriteria;
    if (!Number.isInteger(count) || count < 0 || count > ACCEPTANCE_CRITERIA_MAX) {
      throw invalid('acceptanceCriteria must be a count');
    }
    if (input.structure === 'none' && count !== 0) throw invalid('no structure, no criteria');
    return this.run(
      this.transactional(async (db) => {
        await lockIntent(db, intentId);
        const intent = await db
          .selectFrom('intents')
          .select('id')
          .where('tenant_id', '=', this.tenantId)
          .where('id', '=', intentId)
          .executeTakeFirst();
        if (!intent) throw new RegistryError('intent_not_found', `intent ${intentId} not found`);
        const last = await db
          .selectFrom('spec_refs')
          .select(sql<number | null>`max(version)`.as('version'))
          .where('tenant_id', '=', this.tenantId)
          .where('intent_id', '=', intentId)
          .executeTakeFirst();
        const spec = await db
          .insertInto('spec_refs')
          .values({
            tenant_id: this.tenantId,
            intent_id: intentId,
            version: (last?.version ?? 0) + 1,
            path: input.path,
            commit_sha: input.commitSha,
            content_sha256: input.contentSha256,
            source_tool: tool,
            structure: input.structure,
            acceptance_criteria: count,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'spec.linked',
          actorType: input.actorType,
          actorId: input.actorId,
          entityId: intentId,
          payload: {
            spec_ref_id: spec.id,
            version: spec.version,
            content_sha256: spec.content_sha256,
            commit_sha: spec.commit_sha,
            cause: input.cause ?? 'linked',
            structure: input.structure,
            acceptance_criteria: count,
          },
        });
        return spec;
      }),
    );
  }

  latest(intentId: string): Promise<SpecRef | undefined> {
    return this.run(
      this.db
        .selectFrom('spec_refs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst(),
    );
  }

  list(intentId: string): Promise<SpecRef[]> {
    return this.run(
      this.db
        .selectFrom('spec_refs')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .orderBy('version')
        .execute(),
    );
  }
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', message);
}
