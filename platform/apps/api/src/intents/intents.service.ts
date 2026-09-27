// Intents and gate decisions for the authenticated caller (D-08 B03 AC3). Access follows the
// project configuration (`access.*`, QUESTIONS.md #66): no role on the project → 404; a read role
// without a create role → 403 on create. Gate decisions go through the shared command handler.
import {
  CommandError,
  decideGate,
  INTENT_CODE_PATTERN,
  projectAccess,
  type Intent,
  type Project,
  type Registry,
  type TenantScope,
} from '@sdlc/core';
import type { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import {
  presentDecision,
  presentIntent,
  presentPlan,
  presentSpec,
  type IntentBody,
} from './present.js';
import type { createIntentSchema, decisionSchema, listIntentsSchema } from './schemas.js';

export interface IntentPage {
  readonly items: readonly IntentBody[];
  readonly next_cursor: string | null;
}

export class IntentsService {
  constructor(private readonly registry: Registry) {}

  async create(p: Principal, body: z.infer<typeof createIntentSchema>): Promise<IntentBody> {
    const project = await p.scope.projects.getBySlug(body.project);
    const access = project ? await projectAccess(p.scope, project.id, p.userId) : undefined;
    if (!project || !access?.canRead) {
      throw new CommandError('project_not_found', `project ${body.project} not found`);
    }
    if (!access.canCreateIntent) {
      throw new CommandError('forbidden', 'the caller may not create intents in this project');
    }
    const intent = await this.registry.createIntent(p.scope, {
      projectId: project.id,
      title: body.title,
      description: body.description,
      createdBy: p.userId,
      riskTier: body.risk_tier,
      dataClass: body.data_class,
      ...(body.budget_usd === undefined ? {} : { budgetUsd: body.budget_usd }),
      ...(body.issue_number === undefined ? {} : { issueNumber: body.issue_number }),
    });
    return presentIntent(intent, project);
  }

  async show(p: Principal, ref: string): Promise<Record<string, unknown>> {
    const { intent, project } = await this.readable(p, ref);
    const [decisions, spec, plan] = await Promise.all([
      p.scope.gateDecisions.listForIntent(intent.id),
      p.scope.specRefs.latest(intent.id),
      p.scope.plans.latest(intent.id),
    ]);
    return {
      ...presentIntent(intent, project),
      spec: presentSpec(spec),
      plan: presentPlan(plan),
      decisions: decisions.map(presentDecision),
    };
  }

  async list(p: Principal, query: z.infer<typeof listIntentsSchema>): Promise<IntentPage> {
    const projects = await this.readableProjects(p, query.project);
    const rows = await p.scope.intents.page({
      projectIds: projects.map((project) => project.id),
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit + 1,
      ...(query.cursor === undefined ? {} : { after: decodeCursor(query.cursor) }),
    });
    const page = rows.slice(0, query.limit);
    const bySlug = new Map(projects.map((project) => [project.id, project]));
    const last = page.at(-1);
    return {
      items: page.map((intent) => presentIntent(intent, bySlug.get(intent.project_id)!)),
      next_cursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.created_at, id: last.id })
          : null,
    };
  }

  async decide(
    p: Principal,
    ref: string,
    gate: string,
    body: z.infer<typeof decisionSchema>,
  ): Promise<Record<string, unknown>> {
    const { intent } = await this.readable(p, ref);
    const row = await decideGate(this.registry, p.scope, {
      intent,
      gate,
      decision: body.decision,
      actorId: p.userId,
      reasonCode: body.reason_code ?? null,
      reasonRef: body.reason_ref ?? null,
      scope: body.scope ?? null,
      source: 'cli',
    });
    return presentDecision(row);
  }

  /** The intent and its project, or `intent_not_found` when the caller cannot read the project. */
  private async readable(p: Principal, ref: string): Promise<{ intent: Intent; project: Project }> {
    const intent = await findIntent(p.scope, ref);
    const project = intent ? await p.scope.projects.getById(intent.project_id) : undefined;
    if (!intent || !project || !(await projectAccess(p.scope, project.id, p.userId)).canRead) {
      throw new CommandError('intent_not_found', `intent ${ref} not found`);
    }
    return { intent, project };
  }

  private async readableProjects(p: Principal, slug: string | undefined): Promise<Project[]> {
    const candidates = slug
      ? [await p.scope.projects.getBySlug(slug)].filter((x): x is Project => x !== undefined)
      : await p.scope.projects.list();
    const readable: Project[] = [];
    for (const project of candidates) {
      if ((await projectAccess(p.scope, project.id, p.userId)).canRead) readable.push(project);
    }
    if (slug && readable.length === 0) {
      throw new CommandError('project_not_found', `project ${slug} not found`);
    }
    return readable;
  }
}

function findIntent(scope: TenantScope, ref: string): Promise<Intent | undefined> {
  return INTENT_CODE_PATTERN.test(ref) ? scope.intents.getByCode(ref) : scope.intents.getById(ref);
}
