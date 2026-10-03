// Gate decisions (design/D-05 section 6.3, D-02 FR-10, FR-11, FR-17; D-08 B02 AC3; ADR-M20).
// Append-only: rows are only inserted, and only through `decide` and `revalidateApprovals`, which
// resolve the oversight mode and check the approver with the policy engine first. The database
// refuses UPDATE, DELETE and TRUNCATE (triggers and grants).
import { canonicalJson, deadlineFrom } from '@sdlc/config';
import {
  EVENT_SOURCES,
  GATE_REASON_CODES,
  type EventSource,
  type GateCode,
  type GateContext,
  type GateReasonCode,
  type ProjectRole,
  type UserId,
} from '@sdlc/contracts';
import type { Kysely } from 'kysely';

import {
  checkApprovalBinding,
  normalizeScope,
  type ApprovalScope,
  type BindingStatus,
} from '../../registry/approval-binding.js';
import {
  decisionViolation,
  type HumanDecision,
  type SystemDecision,
} from '../../registry/decision-rules.js';
import {
  clock,
  loadEffectiveConfig,
  type EffectiveConfig,
  type RegistryDeps,
} from '../../registry/effective-config.js';
import { RegistryError } from '../../registry/errors.js';
import { DbError } from '../errors.js';
import type { Database, GateDecisionRow, Intent } from '../schema.js';
import type { TenantId } from '../tenant-id.js';
import type { GateDecisionSource } from '../vocabulary.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { lockIntent } from './locks.js';
import { latestPlan } from './plans.js';
import { ProjectConfigRepository } from './project-configs.js';

interface DecisionBase {
  readonly intentId: string;
  readonly gate: GateCode;
  /** Hash of the gate's input (spec, plan, diff…): the version the decision is bound to. */
  readonly inputSha256: string;
  /** Required for reject, request_changes, block and fail. Never free text (ADR-M20). */
  readonly reasonCode?: GateReasonCode | null;
  /** Link to the Git host comment that holds the human explanation (`https://…`). */
  readonly reasonRef?: string | null;
  /** Facts that change the oversight mode: G8 environment, G6 findings, G5 breach. */
  readonly context?: GateContext;
  /** Time spent waiting for the approver (FR-12 metric). */
  readonly waitedSeconds?: number | null;
}

export interface HumanDecisionInput extends DecisionBase {
  readonly actor: { readonly type: 'human'; readonly id: UserId };
  readonly decision: HumanDecision;
  /**
   * Producers of the change under review, chosen by the caller for this gate (commit authors,
   * run starter; the intent creator at G7). They never approve (FR-11, QUESTIONS.md #16).
   */
  readonly producers: readonly UserId[];
  /** Approvals only: what the approval covers (D-03 section 6.3). */
  readonly scope?: ApprovalScope | null;
  readonly source: Exclude<GateDecisionSource, 'workflow'>;
  readonly eventSource?: EventSource | null;
}

export interface SystemDecisionInput extends DecisionBase {
  readonly actor: { readonly type: 'system' };
  readonly decision: SystemDecision;
  readonly source: 'workflow';
}

export type DecideInput = HumanDecisionInput | SystemDecisionInput;

export interface RevalidateInput {
  readonly intentId: string;
  readonly gate: GateCode;
  /** Hash of the input as it is now, just before the protected action. */
  readonly inputSha256: string;
  /** Scope of the protected action. */
  readonly scope?: ApprovalScope | null;
}

export interface RevalidateResult {
  /** Approvals that are still bound to the current input, scope and time. */
  readonly valid: readonly GateDecisionRow[];
  /** The `void` decisions written for the approvals that no longer hold. */
  readonly voided: readonly GateDecisionRow[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const REASON_REF = /^https:\/\/\S+$/;
const MAX_REASON_REF = 512;

type Insert = Omit<GateDecisionRow, 'id' | 'tenant_id' | 'created_at' | 'scope'> & {
  readonly scope: string | null;
};

export class GateDecisionRepository extends TenantRepository {
  /**
   * Records one gate decision. In one transaction, holding the intent lock:
   * resolves the oversight mode from the project configuration (latest plan's change flags,
   * the caller's gate context), checks the registry rules, and for a human decision checks the
   * actor with the policy engine (`canApprove` for approvals). An approval is bound to
   * `inputSha256`, its scope and an expiry from `oversight.approval_expiry`.
   * Appends `gate.decided` to the audit log in the same transaction.
   */
  async decide(input: DecideInput, deps: RegistryDeps): Promise<GateDecisionRow> {
    checkBase(input);
    const now = clock(deps);
    return this.run(
      this.transactional(async (db) => {
        const { intent, effective } = await this.lockedIntent(db, input.intentId);
        const policy = deps.policyFactory(effective.config);
        const plan = await latestPlan(db, this.tenantId, intent.id);
        const changeFlags = plan?.change_flags ?? [];
        const oversight = policy.oversightMode({
          gate: input.gate,
          riskTier: intent.risk_tier,
          changeFlags,
          ...(input.context === undefined ? {} : { context: input.context }),
        });
        const reasonCode = input.reasonCode ?? null;
        const violation = decisionViolation({
          gate: input.gate,
          decision: input.decision,
          actorType: input.actor.type,
          mode: oversight.mode,
          reasonCode,
          ...(input.context === undefined ? {} : { context: input.context }),
        });
        if (violation) {
          throw new RegistryError(
            'decision_not_allowed',
            `${input.gate} ${input.decision}: ${violation}`,
            violation,
          );
        }

        const base = {
          intent_id: intent.id,
          gate: input.gate,
          decision: input.decision,
          oversight_mode: oversight.mode,
          reason_code: reasonCode,
          reason_ref: input.reasonRef ?? null,
          input_sha256: input.inputSha256,
          config_hash: effective.configHash,
          waited_seconds: input.waitedSeconds ?? null,
          voids_decision_id: null,
        };
        if (!isHuman(input)) {
          return this.insert(
            db,
            {
              ...base,
              actor_type: 'system',
              decided_by: null,
              approver_role: null,
              scope: null,
              expires_at: null,
              source: 'workflow',
              event_source: null,
            },
            now,
          );
        }

        const actorId = input.actor.id;
        const bindings = (await this.actorBindings(db, intent.project_id, actorId)).map((b) => ({
          role: b.role,
          revokedAt: b.revoked_at,
        }));
        let role: ProjectRole;
        let scope: ApprovalScope | null = null;
        let expiresAt: Date | null = null;
        if (input.decision === 'approve') {
          const prior = (await this.currentApprovals(db, intent.id, input.gate))
            .filter((a) => a.input_sha256 === input.inputSha256 && (a.expires_at ?? now) > now)
            .map((a) => ({ userId: a.decided_by!, role: a.approver_role! }));
          const verdict = policy.canApprove({
            gate: input.gate,
            actor: { id: actorId, type: 'human' },
            roles: bindings,
            intent: { riskTier: intent.risk_tier, changeFlags },
            ...(input.context === undefined ? {} : { context: input.context }),
            producers: input.producers,
            priorApprovals: prior,
          });
          if (!verdict.allowed) {
            throw new RegistryError(
              'approval_refused',
              `${input.gate} approval refused: ${verdict.reason}`,
              verdict.reason,
            );
          }
          role = verdict.role;
          scope = normalizeScope(input.scope);
          // A duration always gives a deadline; null is only for "next planned work".
          expiresAt = deadlineFrom(
            now,
            effective.config.oversight.approval_expiry,
            effective.config.escalation.calendar,
          );
          if (expiresAt === null) throw invalid('approval_expiry must be a duration');
        } else {
          // Other human decisions: the actor must hold one of the gate's roles.
          const held = bindings.filter((b) => b.revokedAt === null).map((b) => b.role);
          const match = oversight.roles.find((r) => held.includes(r));
          if (match === undefined) {
            throw new RegistryError(
              'decision_not_allowed',
              `${input.gate} ${input.decision}: role_missing`,
              'role_missing',
            );
          }
          role = match;
        }
        return this.insert(
          db,
          {
            ...base,
            actor_type: 'human',
            decided_by: actorId,
            approver_role: role,
            scope: scope === null ? null : canonicalJson(scope),
            expires_at: expiresAt,
            source: input.source,
            event_source: input.eventSource ?? null,
          },
          now,
        );
      }),
    );
  }

  /**
   * Re-checks the current approvals of a gate just before the protected action (FR-17). Each one
   * that is expired or bound to another input or scope gets a `void` decision (system actor,
   * reason `expired`, `input_mismatch` or `scope_mismatch`), written with its audit event in one
   * transaction. The caller then evaluates the gate again.
   */
  async revalidateApprovals(input: RevalidateInput, deps: RegistryDeps): Promise<RevalidateResult> {
    if (!SHA256.test(input.inputSha256)) throw invalid('inputSha256 must be a SHA-256 digest');
    const currentScope = normalizeScope(input.scope);
    const now = clock(deps);
    return this.run(
      this.transactional(async (db) => {
        const { intent, effective } = await this.lockedIntent(db, input.intentId);
        const valid: GateDecisionRow[] = [];
        const voided: GateDecisionRow[] = [];
        for (const approval of await this.currentApprovals(db, intent.id, input.gate)) {
          const status: BindingStatus = checkApprovalBinding(approval, {
            inputSha256: input.inputSha256,
            scope: currentScope,
            now,
          });
          if (status === 'valid') {
            valid.push(approval);
            continue;
          }
          voided.push(
            await this.insertVoid(db, intent.id, effective.configHash, approval, status, now),
          );
        }
        return { valid, voided };
      }),
    );
  }

  /**
   * Voids every current approval of a gate (system actor, `reasonCode`), whatever its binding: the
   * gate must be decided again. C07: G5 sends the intent back to G3 (a run outside its plan, or a
   * `modify` or `roll_back` decision on a G5 escalation); the G3 approval of the earlier round no
   * longer counts, and its approver may approve again (ADR-M34 §2.8). Call under the intent lock.
   */
  async voidApprovals(
    input: {
      readonly intentId: string;
      readonly gate: GateCode;
      readonly reasonCode: GateReasonCode;
    },
    deps: RegistryDeps,
  ): Promise<GateDecisionRow[]> {
    if (!(GATE_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
      throw invalid('reasonCode must be a gate reason code');
    }
    const now = clock(deps);
    return this.run(
      this.transactional(async (db) => {
        const { intent, effective } = await this.lockedIntent(db, input.intentId);
        const voided: GateDecisionRow[] = [];
        for (const approval of await this.currentApprovals(db, intent.id, input.gate)) {
          voided.push(
            await this.insertVoid(
              db,
              intent.id,
              effective.configHash,
              approval,
              input.reasonCode,
              now,
            ),
          );
        }
        return voided;
      }),
    );
  }

  /**
   * Voids one current approval (system actor, `reasonCode`). E01: the GitHub review behind a G7
   * approval was dismissed or replaced, so the approval no longer holds (FR-17). Returns null when
   * the decision is not a current approval of the intent. Call under the intent lock.
   */
  async voidApproval(
    input: {
      readonly intentId: string;
      readonly decisionId: string;
      readonly reasonCode: GateReasonCode;
    },
    deps: RegistryDeps,
  ): Promise<GateDecisionRow | null> {
    if (!(GATE_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
      throw invalid('reasonCode must be a gate reason code');
    }
    const now = clock(deps);
    return this.run(
      this.transactional(async (db) => {
        const { intent, effective } = await this.lockedIntent(db, input.intentId);
        const target = await db
          .selectFrom('gate_decisions')
          .select('gate')
          .where('tenant_id', '=', this.tenantId)
          .where('intent_id', '=', intent.id)
          .where('id', '=', input.decisionId)
          .executeTakeFirst();
        if (!target) return null;
        const approval = (await this.currentApprovals(db, intent.id, target.gate)).find(
          (a) => a.id === input.decisionId,
        );
        if (!approval) return null;
        return this.insertVoid(
          db,
          intent.id,
          effective.configHash,
          approval,
          input.reasonCode,
          now,
        );
      }),
    );
  }

  private insertVoid(
    db: Kysely<Database>,
    intentId: string,
    configHash: string,
    approval: GateDecisionRow,
    reasonCode: GateReasonCode,
    now: Date,
  ): Promise<GateDecisionRow> {
    return this.insert(
      db,
      {
        intent_id: intentId,
        gate: approval.gate,
        decision: 'void',
        oversight_mode: approval.oversight_mode,
        approver_role: null,
        actor_type: 'system',
        decided_by: null,
        reason_code: reasonCode,
        reason_ref: null,
        input_sha256: approval.input_sha256,
        scope: null,
        expires_at: null,
        config_hash: configHash,
        source: 'workflow',
        event_source: null,
        waited_seconds: null,
        voids_decision_id: approval.id,
      },
      now,
    );
  }

  getById(id: string): Promise<GateDecisionRow | undefined> {
    return this.run(
      this.db
        .selectFrom('gate_decisions')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /** Every decision of an intent, oldest first; optionally one gate only. */
  listForIntent(intentId: string, gate?: GateCode): Promise<GateDecisionRow[]> {
    return this.run(
      this.db
        .selectFrom('gate_decisions')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('intent_id', '=', intentId)
        .$if(gate !== undefined, (qb) => qb.where('gate', '=', gate!))
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
  }

  /** Approvals of a gate that no `void` decision cancelled. Expiry is not checked here. */
  currentApprovalsFor(intentId: string, gate: GateCode): Promise<GateDecisionRow[]> {
    return this.run(this.currentApprovals(this.db, intentId, gate));
  }

  private async currentApprovals(
    db: Kysely<Database>,
    intentId: string,
    gate: GateCode,
  ): Promise<GateDecisionRow[]> {
    const rows = await db
      .selectFrom('gate_decisions')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('intent_id', '=', intentId)
      .where('gate', '=', gate)
      .where('decision', 'in', ['approve', 'void'])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const voided = new Set(rows.map((r) => r.voids_decision_id).filter((id) => id !== null));
    return rows.filter((r) => r.decision === 'approve' && !voided.has(r.id));
  }

  private async lockedIntent(
    db: Kysely<Database>,
    intentId: string,
  ): Promise<{ intent: Intent; effective: EffectiveConfig }> {
    await lockIntent(db, intentId);
    const intent = await db
      .selectFrom('intents')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', intentId)
      .executeTakeFirst();
    if (!intent) throw new RegistryError('intent_not_found', `intent ${intentId} not found`);
    const effective = await loadEffectiveConfig(
      new ProjectConfigRepository(db, this.tenantId),
      intent.project_id,
    );
    return { intent, effective };
  }

  private actorBindings(db: Kysely<Database>, projectId: string, userId: string) {
    return db
      .selectFrom('role_bindings')
      .select(['role', 'revoked_at'])
      .where('tenant_id', '=', this.tenantId)
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /**
   * Inserts one decision and its `gate.decided` audit event. The event's `occurred_at` is the
   * registry clock (the time the rules were checked with): time rules on decisions (the HOTL block
   * window, the gate clock after a request for changes) read it from the audit chain, on one clock
   * with the intent's `gate_entered_at` (B07 session 2).
   */
  private async insert(db: Kysely<Database>, row: Insert, at: Date): Promise<GateDecisionRow> {
    const saved = await db
      .insertInto('gate_decisions')
      .values({ ...row, tenant_id: this.tenantId })
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendDecided(db, this.tenantId, saved, at);
    return saved;
  }
}

function appendDecided(db: Kysely<Database>, tenantId: TenantId, row: GateDecisionRow, at: Date) {
  return new AuditLogRepository(db, tenantId).append({
    action: 'gate.decided',
    occurredAt: at,
    actorType: row.actor_type,
    actorId: row.decided_by,
    entityId: row.intent_id,
    payload: {
      decision_id: row.id,
      gate: row.gate,
      decision: row.decision,
      oversight_mode: row.oversight_mode,
      input_sha256: row.input_sha256,
      config_hash: row.config_hash,
      ...(row.approver_role === null ? {} : { approver_role: row.approver_role }),
      ...(row.reason_code === null ? {} : { reason_code: row.reason_code }),
      ...(row.voids_decision_id === null ? {} : { voids_decision_id: row.voids_decision_id }),
    },
  });
}

function checkBase(input: DecideInput): void {
  if (!SHA256.test(input.inputSha256)) throw invalid('inputSha256 must be a SHA-256 digest');
  const reason = input.reasonCode ?? null;
  if (reason !== null && !GATE_REASON_CODES.includes(reason)) throw invalid('unknown reason code');
  const ref = input.reasonRef ?? null;
  if (ref !== null && (ref.length > MAX_REASON_REF || !REASON_REF.test(ref))) {
    throw invalid(`reasonRef must be an https URL of at most ${String(MAX_REASON_REF)} characters`);
  }
  const waited = input.waitedSeconds ?? null;
  if (waited !== null && (!Number.isSafeInteger(waited) || waited < 0)) {
    throw invalid('waitedSeconds must be an integer >= 0');
  }
  if (isHuman(input)) {
    const eventSource = input.eventSource ?? null;
    if (eventSource !== null && !EVENT_SOURCES.includes(eventSource)) {
      throw invalid('unknown event source');
    }
    if (eventSource !== null && input.source === 'cli') {
      throw invalid('eventSource is only for decisions read from the Git host');
    }
    if (!Array.isArray(input.producers)) throw invalid('producers must be a list of user IDs');
    if (input.decision !== 'approve' && input.scope != null) {
      throw invalid('only an approval has a scope');
    }
  }
}

/** The actor is nested, so TypeScript cannot narrow the union on it by itself. */
function isHuman(input: DecideInput): input is HumanDecisionInput {
  return input.actor.type === 'human';
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', message);
}
