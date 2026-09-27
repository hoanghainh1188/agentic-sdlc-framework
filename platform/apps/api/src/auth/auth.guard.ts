// Bearer-token authentication for every route that is not public (D-08 B03 AC1, AC2).
// The token is checked for shape, hashed, and looked up by its hash only; it is never logged.
import { SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { hashApiToken, isApiTokenFormat, type PlatformDatabase } from '@sdlc/core';

import { ApiError } from '../errors/api-error.js';
import type { AuthenticatedRequest } from './principal.js';
import type { RateLimiter } from './rate-limiter.js';

const PUBLIC = 'sdlc:public';

/** Marks a route that needs no token (health checks only). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

/** `last_used_at` is written at most once per token per interval (ADR-M26 D6). */
const TOUCH_INTERVAL_MS = 60_000;

interface GuardRequest extends AuthenticatedRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip: string;
}

export interface AuthGuardDeps {
  readonly reflector: Reflector;
  readonly db: PlatformDatabase;
  /** Requests per token and minute. */
  readonly requests: RateLimiter;
  /** Failed authentications per client address and minute. */
  readonly failures: RateLimiter;
  readonly now: () => Date;
}

export class AuthGuard implements CanActivate {
  readonly #lastTouch = new Map<string, number>();

  constructor(private readonly deps: AuthGuardDeps) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.deps.reflector.getAllAndOverride<boolean | undefined>(PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<GuardRequest>();
    const client = `ip:${request.ip}`;
    if (this.deps.failures.blocked(client)) throw new ApiError(429, 'rate_limited');

    const token = bearerToken(request.headers.authorization);
    const now = this.deps.now();
    const resolved =
      token !== undefined && isApiTokenFormat(token)
        ? await this.deps.db.system.resolveApiToken(hashApiToken(token), now)
        : undefined;
    if (!resolved) {
      this.deps.failures.hit(client);
      throw new ApiError(401, 'unauthorized');
    }
    if (!this.deps.requests.hit(`token:${resolved.tokenId}`)) {
      throw new ApiError(429, 'rate_limited');
    }
    const scope = this.deps.db.forTenant(resolved.tenantId);
    await this.#touch(resolved.tokenId, scope, now);
    request.principal = { ...resolved, scope };
    return true;
  }

  async #touch(
    tokenId: string,
    scope: ReturnType<PlatformDatabase['forTenant']>,
    now: Date,
  ): Promise<void> {
    const at = now.getTime();
    const last = this.#lastTouch.get(tokenId);
    if (last !== undefined && at - last < TOUCH_INTERVAL_MS) return;
    // Keep only tokens used within the interval, so the map never grows with old tokens.
    for (const [id, time] of this.#lastTouch) {
      if (at - time >= TOUCH_INTERVAL_MS) this.#lastTouch.delete(id);
    }
    this.#lastTouch.set(tokenId, at);
    await scope.apiTokens.touchLastUsed(tokenId, now);
  }
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}
