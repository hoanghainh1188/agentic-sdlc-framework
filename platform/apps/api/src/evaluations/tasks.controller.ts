// A project's own evaluation task endpoints (task L07, design/ADR-M85 §2.2, §2.6). Token callers
// only: the dashboard has no task action (no `@SessionAction`).
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { EVAL_TASKS } from '../tokens.js';
import { parseRequest } from '../validation.js';
import {
  approveTaskSchema,
  draftTaskSchema,
  evalTaskIdSchema,
  projectSlugSchema,
  registerTaskSchema,
  rejectTaskSchema,
} from './schemas.js';
import type { EvaluationTasksService } from './tasks.service.js';

@Controller('v1/projects/:project/eval-tasks')
export class ProjectEvalTasksController {
  constructor(@Inject(EVAL_TASKS) private readonly tasks: EvaluationTasksService) {}

  @Get()
  list(@CurrentPrincipal() p: Principal, @Param('project') project: string) {
    return this.tasks.list(p, parseRequest(projectSlugSchema, project, 'path'));
  }

  /** A draft card from a merged intent; nothing is stored (ADR-M85 §2.2). */
  @Get('draft')
  draft(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
    @Query() query: unknown,
  ) {
    return this.tasks.draft(
      p,
      parseRequest(projectSlugSchema, project, 'path'),
      parseRequest(draftTaskSchema, query, 'query'),
    );
  }

  /** Registers the card of a task from the default branch. */
  @Post()
  @HttpCode(200)
  register(
    @CurrentPrincipal() p: Principal,
    @Param('project') project: string,
    @Body() body: unknown,
  ) {
    return this.tasks.register(
      p,
      parseRequest(projectSlugSchema, project, 'path'),
      parseRequest(registerTaskSchema, body, 'body'),
    );
  }
}

@Controller('v1/eval-tasks/:id')
export class EvalTasksController {
  constructor(@Inject(EVAL_TASKS) private readonly tasks: EvaluationTasksService) {}

  @Post('approve')
  @HttpCode(200)
  approve(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.review(
      p,
      parseRequest(evalTaskIdSchema, id, 'path'),
      parseRequest(approveTaskSchema, body, 'body'),
      'approved',
    );
  }

  @Post('reject')
  @HttpCode(200)
  reject(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.tasks.review(
      p,
      parseRequest(evalTaskIdSchema, id, 'path'),
      parseRequest(rejectTaskSchema, body, 'body'),
      'rejected',
    );
  }
}
