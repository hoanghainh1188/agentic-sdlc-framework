// Puts the caller's tenant into the log context of the request and on its span (D-08 A08 AC1,
// design/ADR-M35 §2.2). Runs after the auth guard, so the principal is known; public routes have
// none. The handler runs inside the context because Nest subscribes to it lazily.
import { trace } from '@opentelemetry/api';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { withLogContext } from '@sdlc/core';
import { Observable } from 'rxjs';

import type { AuthenticatedRequest } from '../auth/principal.js';

export class LogContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tenantId = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal?.tenantId;
    if (tenantId === undefined) return next.handle();
    trace.getActiveSpan()?.setAttribute('sdlc.tenant_id', tenantId);
    return new Observable((subscriber) =>
      withLogContext({ tenantId }, () => next.handle().subscribe(subscriber)),
    );
  }
}
