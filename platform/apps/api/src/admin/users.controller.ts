// Admin endpoints for users and their Git host identities (task B13 AC2, AC3; ADR-M37 §2.6).
// Tenant admins only. Users are addressed by ID: an e-mail address never goes into a URL.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  issueTokenFor,
  listTokensOf,
  revokeTokenOf,
  createUser,
  isTenantAdmin,
  linkIdentity,
  listIdentities,
  listTenantRoles,
  listUsers,
  setUserActive,
  showUser,
  unlinkIdentity,
  updateUser,
  type User,
} from '@sdlc/core';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { CLOCK } from '../tokens.js';
import { parseRequest } from '../validation.js';
import { actorOf } from './actor.js';
import { presentIdentity, presentIssuedToken, presentToken, presentUser } from './present.js';
import {
  createUserSchema,
  historyQuerySchema,
  idSchema,
  issueTokenSchema,
  linkIdentitySchema,
  updateUserSchema,
} from './schemas.js';

type Body = Record<string, unknown>;

@Controller('v1/admin/users')
export class AdminUsersController {
  constructor(@Inject(CLOCK) private readonly now: () => Date) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal): Promise<Body> {
    const users = await listUsers(p.scope, actorOf(p));
    const admins = new Set(
      (await listTenantRoles(p.scope, actorOf(p))).map((binding) => binding.user_id),
    );
    return { items: users.map((user) => presentUser(user, admins.has(user.id))) };
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentPrincipal() p: Principal, @Body() body: unknown): Promise<Body> {
    const input = parseRequest(createUserSchema, body, 'body');
    const user = await createUser(p.scope, actorOf(p), {
      email: input.email,
      displayName: input.display_name,
    });
    return presentUser(user, false);
  }

  @Get(':user')
  async show(@CurrentPrincipal() p: Principal, @Param('user') id: string): Promise<Body> {
    return this.present(p, await showUser(p.scope, actorOf(p), parseRequest(idSchema, id, 'path')));
  }

  @Patch(':user')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const input = parseRequest(updateUserSchema, body, 'body');
    const user = await updateUser(p.scope, actorOf(p), parseRequest(idSchema, id, 'path'), {
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
    });
    return this.present(p, user);
  }

  @Post(':user/disable')
  @HttpCode(200)
  async disable(@CurrentPrincipal() p: Principal, @Param('user') id: string): Promise<Body> {
    const user = await setUserActive(
      p.scope,
      actorOf(p),
      parseRequest(idSchema, id, 'path'),
      false,
    );
    return this.present(p, user);
  }

  @Post(':user/enable')
  @HttpCode(200)
  async enable(@CurrentPrincipal() p: Principal, @Param('user') id: string): Promise<Body> {
    const user = await setUserActive(p.scope, actorOf(p), parseRequest(idSchema, id, 'path'), true);
    return this.present(p, user);
  }

  @Get(':user/identities')
  async identities(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Query() query: unknown,
  ): Promise<Body> {
    const history = parseRequest(historyQuerySchema, query, 'query');
    const identities = await listIdentities(
      p.scope,
      actorOf(p),
      parseRequest(idSchema, id, 'path'),
      history.include_unlinked === 'true',
    );
    return { items: identities.map(presentIdentity) };
  }

  @Post(':user/identities')
  @HttpCode(201)
  async link(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const input = parseRequest(linkIdentitySchema, body, 'body');
    const identity = await linkIdentity(p.scope, actorOf(p), parseRequest(idSchema, id, 'path'), {
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      externalId: input.external_id,
      externalLogin: input.external_login,
    });
    return presentIdentity(identity);
  }

  @Delete(':user/identities/:identity')
  async unlink(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Param('identity') identityId: string,
  ): Promise<Body> {
    const identity = await unlinkIdentity(
      p.scope,
      actorOf(p),
      parseRequest(idSchema, id, 'path'),
      parseRequest(idSchema, identityId, 'path'),
    );
    return presentIdentity(identity);
  }

  // Other users' tokens (B13 AC5, QUESTIONS #152): a token issued for someone else lives at most
  // 7 days; the user creates their own and revokes it.
  @Get(':user/tokens')
  async tokens(@CurrentPrincipal() p: Principal, @Param('user') id: string): Promise<Body> {
    const tokens = await listTokensOf(p.scope, actorOf(p), parseRequest(idSchema, id, 'path'));
    return { items: tokens.map(presentToken) };
  }

  @Post(':user/tokens')
  @HttpCode(201)
  async issueToken(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Body() body: unknown,
  ): Promise<Body> {
    const input = parseRequest(issueTokenSchema, body, 'body');
    const issued = await issueTokenFor(p.scope, actorOf(p), parseRequest(idSchema, id, 'path'), {
      name: input.name,
      now: this.now(),
      ...(input.days === undefined ? {} : { lifetimeDays: input.days }),
    });
    return presentIssuedToken(issued);
  }

  @Delete(':user/tokens/:token')
  async revokeToken(
    @CurrentPrincipal() p: Principal,
    @Param('user') id: string,
    @Param('token') tokenId: string,
  ): Promise<Body> {
    const revoked = await revokeTokenOf(
      p.scope,
      actorOf(p),
      parseRequest(idSchema, id, 'path'),
      parseRequest(idSchema, tokenId, 'path'),
      this.now(),
    );
    return presentToken(revoked);
  }

  private async present(p: Principal, user: User): Promise<Body> {
    return presentUser(user, await isTenantAdmin(p.scope, user.id));
  }
}
