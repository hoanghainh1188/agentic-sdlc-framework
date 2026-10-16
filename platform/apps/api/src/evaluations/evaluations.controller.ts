// Evaluation plan and evaluation endpoints (task L05, design/ADR-M82 §2.7). Token callers only in
// this PR; the dashboard's four session actions come with L05 PR 5 (CSRF, passkey step-up).
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';

import { SessionAction } from '../auth/auth.guard.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { EVALUATIONS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { EvaluationsService } from './evaluations.service.js';
import {
  changePlanSchema,
  createPlanSchema,
  evaluationCodeSchema,
  listEvaluationsSchema,
  planIdSchema,
  projectSlugSchema,
  runPlanSchema,
} from './schemas.js';

@Controller('v1/projects/:project/eval-plans')
export class ProjectEvalPlansController {
  constructor(@Inject(EVALUATIONS) private readonly evaluations: EvaluationsService) {}

  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
  ): Promise<Record<string, unknown>> {
    return this.evaluations.listPlans(p, parseRequest(projectSlugSchema, project, 'path'));
  }

  @Post()
  @HttpCode(201)
  // L05 (ADR-M82 §2.7, QUESTIONS #470): one of the four plan actions a dashboard session may send.
  @SessionAction('actions')
  create(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.evaluations.createPlan(
      p,
      parseRequest(projectSlugSchema, project, 'path'),
      parseRequest(createPlanSchema, body, 'body'),
      body as Record<string, unknown>,
    );
  }
}

@Controller('v1/eval-plans/:plan')
export class EvalPlansController {
  constructor(@Inject(EVALUATIONS) private readonly evaluations: EvaluationsService) {}

  @Get()
  show(@CurrentPrincipal() p: Principal, @Param('plan') plan: string) {
    return this.evaluations.showPlan(p, parseRequest(planIdSchema, plan, 'path'));
  }

  @Post('versions')
  @HttpCode(201)
  @SessionAction('actions')
  change(@CurrentPrincipal() p: Principal, @Param('plan') plan: string, @Body() body: unknown) {
    return this.evaluations.changePlan(
      p,
      parseRequest(planIdSchema, plan, 'path'),
      parseRequest(changePlanSchema, body, 'body'),
      body as Record<string, unknown>,
    );
  }

  @Post('archive')
  @HttpCode(200)
  @SessionAction('actions')
  archive(@CurrentPrincipal() p: Principal, @Param('plan') plan: string) {
    return this.evaluations.archivePlan(p, parseRequest(planIdSchema, plan, 'path'));
  }

  /** Run now: the worker starts the run within a pass of its loop (QUESTIONS #476). */
  @Post('runs')
  @HttpCode(202)
  @SessionAction('actions')
  run(@CurrentPrincipal() p: Principal, @Param('plan') plan: string, @Body() body: unknown) {
    return this.evaluations.requestRun(
      p,
      parseRequest(planIdSchema, plan, 'path'),
      parseRequest(runPlanSchema, body ?? {}, 'body') && ((body ?? {}) as Record<string, unknown>),
    );
  }
}

@Controller('v1/evaluations')
export class EvaluationsController {
  constructor(@Inject(EVALUATIONS) private readonly evaluations: EvaluationsService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @Query() query: unknown) {
    return this.evaluations.listEvaluations(p, parseRequest(listEvaluationsSchema, query, 'query'));
  }

  /** Evaluations that ended in the last 7 days (the notice of task L06, QUESTIONS #482). */
  @Get('recent')
  recent(@CurrentPrincipal() p: Principal) {
    return this.evaluations.recent(p);
  }

  /** The report of one evaluation (task L06, ADR-M83). Read only. */
  @Get(':code/report')
  report(@CurrentPrincipal() p: Principal, @Param('code') code: string) {
    return this.evaluations.report(p, parseRequest(evaluationCodeSchema, code, 'path'));
  }

  @Get(':code')
  show(@CurrentPrincipal() p: Principal, @Param('code') code: string) {
    return this.evaluations.showEvaluation(p, parseRequest(evaluationCodeSchema, code, 'path'));
  }
}
