// The tool register through the API (task X04, ADR-M69 §2.2). Any person of the tenant reads it;
// the changes follow the approval rules of `@sdlc/core` tools/approvals (the agent register's
// capacities: the owner and Person B or governance activate; the owner and governance retire).
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import {
  approveTool,
  changeToolOwnerAs,
  defaultToolRecertificationMonths,
  recertifyToolAs,
  registerToolAs,
  stopToolAs,
  ToolRegisterError,
  toolRound,
  updateToolAs,
  type Tool,
} from '@sdlc/core';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { toolApiError } from '../errors/api-error.js';
import { CLOCK } from '../tokens.js';
import { parseRequest } from '../validation.js';
import { actorOf } from './actor.js';
import {
  approveToolSchema,
  changeOwnerSchema,
  recertifySchema,
  registerToolSchema,
  stopAgentSchema,
  toolKeySchema,
  updateToolSchema,
} from './schemas.js';
import { presentTool, presentToolRound } from './tools.present.js';

type Body = Record<string, unknown>;

@Controller('v1/admin/tools')
export class AdminToolsController {
  constructor(@Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal): Promise<Body> {
    const months = defaultToolRecertificationMonths();
    return {
      items: (await p.scope.tools.list()).map((tool) => presentTool(tool, months, this.now())),
    };
  }

  @Get(':key')
  async show(@CurrentPrincipal() p: Principal, @Param('key') key: string): Promise<Body> {
    const toolKey = parseRequest(toolKeySchema, key, 'path');
    return this.call(toolKey, async () => {
      const months = defaultToolRecertificationMonths();
      const [activate, retire] = await Promise.all([
        toolRound(p.scope, toolKey, 'activate'),
        toolRound(p.scope, toolKey, 'retire'),
      ]);
      return {
        ...presentTool(activate.tool, months, this.now()),
        rounds: [activate, retire].map((round) => presentToolRound(round, months, this.now())),
      };
    });
  }

  @Post()
  @HttpCode(201)
  async register(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<Body> {
    const input = parseRequest(registerToolSchema, body, 'body');
    return this.call(input.key, async () =>
      this.present(
        await registerToolAs(p.scope, actorOf(p), {
          toolKey: input.key,
          version: input.version,
          ownerId: input.owner_id,
          transport: input.transport,
          imageRef: input.image_ref ?? null,
          imageDigest: input.image_digest ?? null,
          permissions: input.permissions,
          allowedDataClasses: input.allowed_data_classes,
          backingServices: input.backing_services,
          modelRef: input.model_ref ?? null,
          now: this.now(),
        }),
      ),
    );
  }

  @Patch(':key')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const toolKey = parseRequest(toolKeySchema, key, 'path');
    const input = parseRequest(updateToolSchema, body, 'body');
    return this.call(toolKey, async () =>
      this.present(
        await updateToolAs(p.scope, actorOf(p), toolKey, {
          version: input.version,
          now: this.now(),
          ...(input.transport === undefined ? {} : { transport: input.transport }),
          ...(input.image_ref === undefined ? {} : { imageRef: input.image_ref }),
          ...(input.image_digest === undefined ? {} : { imageDigest: input.image_digest }),
          ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
          ...(input.allowed_data_classes === undefined
            ? {}
            : { allowedDataClasses: input.allowed_data_classes }),
          ...(input.backing_services === undefined
            ? {}
            : { backingServices: input.backing_services }),
          ...(input.model_ref === undefined ? {} : { modelRef: input.model_ref }),
        }),
      ),
    );
  }

  /** Approves the activation or retirement; the approval that completes a set changes the status. */
  @Post(':key/approvals')
  @HttpCode(200)
  async approve(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const toolKey = parseRequest(toolKeySchema, key, 'path');
    const input = parseRequest(approveToolSchema, body, 'body');
    return this.call(toolKey, async () => {
      const result = await approveTool(p.scope, actorOf(p), toolKey, {
        purpose: input.purpose,
        capacity: input.as,
        now: this.now(),
        ...(input.reason_code === undefined ? {} : { reason: input.reason_code }),
      });
      return presentToolRound(result, defaultToolRecertificationMonths(), this.now());
    });
  }

  @Post(':key/suspend')
  @HttpCode(200)
  suspend(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body() body: unknown) {
    return this.stop(p, key, body, 'suspended');
  }

  @Post(':key/quarantine')
  @HttpCode(200)
  quarantine(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body() body: unknown) {
    return this.stop(p, key, body, 'quarantined');
  }

  @Put(':key/owner')
  async owner(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const toolKey = parseRequest(toolKeySchema, key, 'path');
    const input = parseRequest(changeOwnerSchema, body, 'body');
    return this.call(toolKey, async () =>
      this.present(
        await changeToolOwnerAs(p.scope, actorOf(p), toolKey, input.owner_id, this.now()),
      ),
    );
  }

  @Post(':key/recertify')
  @HttpCode(200)
  async recertify(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const toolKey = parseRequest(toolKeySchema, key, 'path');
    const input = parseRequest(recertifySchema, body ?? {}, 'body');
    if (input.evaluation_code !== undefined) {
      // Tools have no evaluations: refuse rather than ignore the field.
      throw toolApiError(
        new ToolRegisterError('invalid_input', 'no evaluation', 'evaluation_code'),
        toolKey,
      );
    }
    return this.call(toolKey, async () =>
      this.present(
        await recertifyToolAs(p.scope, actorOf(p), toolKey, {
          now: this.now(),
          ...(input.day === undefined ? {} : { day: input.day }),
        }),
      ),
    );
  }

  private async stop(
    p: Principal,
    key: string,
    body: unknown,
    to: 'suspended' | 'quarantined',
  ): Promise<Body> {
    const toolKey = parseRequest(toolKeySchema, key, 'path');
    const input = parseRequest(stopAgentSchema, body, 'body');
    return this.call(toolKey, async () =>
      this.present(
        await stopToolAs(p.scope, actorOf(p), toolKey, to, input.reason_code, this.now()),
      ),
    );
  }

  private present(tool: Tool): Body {
    return presentTool(tool, defaultToolRecertificationMonths(), this.now());
  }

  /** Register refusals carry the tool key into their catalog text. */
  private async call(toolKey: string, work: () => Promise<Body>): Promise<Body> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof ToolRegisterError ? toolApiError(error, toolKey) : error;
    }
  }
}
