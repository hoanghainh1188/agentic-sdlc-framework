// The dashboard sign-in endpoints (task U05, design/ADR-M73 §2.2). They change no intent, gate, run
// or escalation: only sessions.
//
// - `GET  /v1/auth/config`                  public: is GitHub sign-in on?
// - `GET  /v1/auth/github/start?tenant=…`   public: pre-login cookie, redirect to GitHub
// - `GET  /v1/auth/github/callback`         public: session cookie, redirect to the dashboard
// - `POST /v1/auth/sign-out`                the session of this request ends
// - `DELETE /v1/me/sessions`                sign out everywhere (every session of the caller)
//
// The redirects go to `/dashboard/` with `?signin=refused|unavailable` on a refusal: one answer
// whatever the cause (ADR-M73 §2.2). Start and callback are rate-limited per client address.
import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { endAllOwnWebSessions, endOwnWebSession } from '@sdlc/core';

import { ApiError } from '../errors/api-error.js';
import { CLOCK, SIGN_IN } from '../tokens.js';
import { Public, SessionWrite } from './auth.guard.js';
import {
  clearCookie,
  OAUTH_COOKIE,
  oauthCookie,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
} from './cookies.js';
import { CurrentPrincipal, type Principal } from './principal.js';
import type { RateLimiter } from './rate-limiter.js';
import type { SignInRefusal, SignInService } from './sign-in.service.js';

/** Sign-ins a whole team behind one address can start per minute (review, LOW-5). */
export const SIGN_IN_STARTS_PER_MINUTE = 20;
/** Callbacks per address and minute: each needs a valid state, so a few more than starts. */
export const SIGN_IN_CALLBACKS_PER_MINUTE = 30;

/** The parts of Fastify's reply used here. */
interface Reply {
  code(status: number): Reply;
  header(name: string, value: string | string[]): Reply;
  send(body?: unknown): Reply;
}

interface Request {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip: string;
}

/** Set when GitHub sign-in is on; undefined otherwise (the endpoints answer 404). */
export interface SignInEndpoints {
  readonly service: SignInService;
  /** Start requests per client address and minute (fewer than callbacks: each start is kept). */
  readonly starts: RateLimiter;
  /** Callback requests per client address and minute. */
  readonly callbacks: RateLimiter;
}

const DASHBOARD = '/dashboard/';

const one = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 512 ? value : undefined;

@Controller('v1')
export class SignInController {
  constructor(
    @Inject(SIGN_IN) private readonly signIn: SignInEndpoints | undefined,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  @Public()
  @Get('auth/config')
  @Header('Cache-Control', 'no-store')
  config(): Record<string, unknown> {
    return { github: this.signIn !== undefined };
  }

  @Public()
  @Get('auth/github/start')
  async start(
    @Query('tenant') tenant: unknown,
    @Req() request: Request,
    @Res() reply: Reply,
  ): Promise<void> {
    const endpoints = this.#endpoints(request, 'starts');
    const result = await endpoints.service.start(one(tenant) ?? '');
    if (!result.ok) {
      redirect(reply, refused(result.refusal));
      return;
    }
    reply.header('set-cookie', oauthCookie(result.handle, result.ttlSeconds));
    redirect(reply, result.redirect);
  }

  @Public()
  @Get('auth/github/callback')
  async callback(
    @Query() query: Record<string, unknown>,
    @Req() request: Request,
    @Res() reply: Reply,
  ): Promise<void> {
    const endpoints = this.#endpoints(request, 'callbacks');
    let result: Awaited<ReturnType<SignInService['callback']>>;
    try {
      result = await endpoints.service.callback({
        handle: readCookie(request.headers.cookie, OAUTH_COOKIE),
        state: one(query.state),
        code: one(query.code),
        error: one(query.error),
        previousSecret: readCookie(request.headers.cookie, SESSION_COOKIE),
      });
    } catch {
      // A database error in a browser navigation: the same redirect as GitHub being unreachable,
      // never a JSON error page (security review, LOW-6). The ErrorFilter is not involved.
      result = { ok: false, refusal: 'unavailable' };
    }
    if (!result.ok) {
      // The pre-login cookie is deleted whatever the result (ADR-M73 §2.2); a session cookie
      // sent with a refused callback stays as it was.
      reply.header('set-cookie', clearCookie(OAUTH_COOKIE));
      redirect(reply, refused(result.refusal));
      return;
    }
    reply.header('set-cookie', [
      clearCookie(OAUTH_COOKIE),
      sessionCookie(result.secret, result.maxAgeSeconds),
    ]);
    redirect(reply, DASHBOARD);
  }

  @Post('auth/sign-out')
  @SessionWrite()
  @HttpCode(204)
  async signOut(
    @CurrentPrincipal() p: Principal,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<void> {
    if (p.credential.kind !== 'session') throw new ApiError(400, 'invalid_request');
    await endOwnWebSession(p.scope, p.userId, p.credential.id, this.now());
    reply.header('set-cookie', clearCookie(SESSION_COOKIE));
  }

  @Delete('me/sessions')
  @SessionWrite()
  async signOutEverywhere(
    @CurrentPrincipal() p: Principal,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<Record<string, unknown>> {
    const ended = await endAllOwnWebSessions(p.scope, p.userId, this.now());
    if (p.credential.kind === 'session') reply.header('set-cookie', clearCookie(SESSION_COOKIE));
    return { ended };
  }

  #endpoints(request: Request, limiter: 'starts' | 'callbacks'): SignInEndpoints {
    if (!this.signIn) throw new ApiError(404, 'not_found');
    if (!this.signIn[limiter].hit(`ip:${request.ip}`)) throw new ApiError(429, 'rate_limited');
    return this.signIn;
  }
}

function refused(refusal: SignInRefusal): string {
  return `${DASHBOARD}?signin=${refusal}`;
}

function redirect(reply: Reply, location: string): void {
  reply.code(302).header('cache-control', 'no-store').header('location', location).send();
}
