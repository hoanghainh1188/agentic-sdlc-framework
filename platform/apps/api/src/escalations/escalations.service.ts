// Escalations for the authenticated caller (D-08 B11 AC5, design/ADR-M28 §2.7). Reading follows
// the project access of intents (no read role → 404, like intents). Acting is checked by the core
// module: owner, backup (from the backup step) or governance, never a producer (FR-18).
import {
  acknowledgeEscalation,
  decideEscalation,
  EscalationError,
  INTENT_CODE_PATTERN,
  projectAccess,
  type Escalation,
  type Intent,
  type TenantScope,
} from '@sdlc/core';
import type { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import { presentEscalation } from './present.js';
import type { escalationDecisionSchema, listEscalationsSchema } from './schemas.js';

export class EscalationsService {
  constructor(private readonly now: () => Date) {}

  async list(
    p: Principal,
    query: z.infer<typeof listEscalationsSchema>,
  ): Promise<{ items: Record<string, unknown>[] }> {
    const statuses = query.status === undefined ? {} : { statuses: [query.status] };
    if (query.intent !== undefined) {
      const intent = await this.readableIntent(p, query.intent);
      if (!intent) throw notFound(query.intent);
      const rows = (await p.scope.escalations.listForIntent(intent.id, statuses)).reverse();
      return { items: rows.slice(0, query.limit).map((e) => presentEscalation(e, intent)) };
    }
    const projects = await p.scope.projects.list();
    const readable: string[] = [];
    for (const project of projects) {
      if ((await projectAccess(p.scope, project.id, p.userId)).canRead) readable.push(project.id);
    }
    const rows = await p.scope.escalations.listForProjects(readable, {
      ...statuses,
      limit: query.limit,
    });
    return { items: await this.present(p.scope, rows) };
  }

  async show(p: Principal, code: string): Promise<Record<string, unknown>> {
    const { escalation, intent } = await this.readable(p, code);
    return presentEscalation(escalation, intent);
  }

  async acknowledge(p: Principal, code: string): Promise<Record<string, unknown>> {
    const { escalation, intent } = await this.readable(p, code);
    const updated = await acknowledgeEscalation(
      p.scope,
      { escalationId: escalation.id, actorId: p.userId },
      { now: this.now },
    );
    return presentEscalation(updated, intent);
  }

  async decide(
    p: Principal,
    code: string,
    body: z.infer<typeof escalationDecisionSchema>,
  ): Promise<Record<string, unknown>> {
    const { escalation, intent } = await this.readable(p, code);
    const updated = await decideEscalation(
      p.scope,
      {
        escalationId: escalation.id,
        actorId: p.userId,
        decision: body.decision,
        reasonCode: body.reason_code ?? null,
        reasonRef: body.reason_ref ?? null,
        ...(body.actions === undefined ? {} : { actions: body.actions }),
        ...(body.budget_increase_usd === undefined
          ? {}
          : { budgetIncreaseUsd: body.budget_increase_usd }),
      },
      { now: this.now },
    );
    return presentEscalation(updated, intent);
  }

  /** The escalation and its intent, or `escalation_not_found` when the caller cannot read it. */
  private async readable(
    p: Principal,
    code: string,
  ): Promise<{ escalation: Escalation; intent: Intent }> {
    const escalation = await p.scope.escalations.getByCode(code);
    const intent = escalation ? await p.scope.intents.getById(escalation.intent_id) : undefined;
    if (
      !escalation ||
      !intent ||
      !(await projectAccess(p.scope, intent.project_id, p.userId)).canRead
    ) {
      throw notFound(code);
    }
    return { escalation, intent };
  }

  private async readableIntent(p: Principal, ref: string): Promise<Intent | undefined> {
    const intent = INTENT_CODE_PATTERN.test(ref)
      ? await p.scope.intents.getByCode(ref)
      : await p.scope.intents.getById(ref);
    if (!intent) return undefined;
    return (await projectAccess(p.scope, intent.project_id, p.userId)).canRead ? intent : undefined;
  }

  private async present(
    scope: TenantScope,
    rows: readonly Escalation[],
  ): Promise<Record<string, unknown>[]> {
    const intents = new Map<string, Intent>();
    for (const row of rows) {
      if (!intents.has(row.intent_id)) {
        const intent = await scope.intents.getById(row.intent_id);
        if (intent) intents.set(intent.id, intent);
      }
    }
    return rows.flatMap((row) => {
      const intent = intents.get(row.intent_id);
      return intent ? [presentEscalation(row, intent)] : [];
    });
  }
}

function notFound(ref: string): EscalationError {
  return new EscalationError('not_found', `escalation ${ref} not found`);
}
