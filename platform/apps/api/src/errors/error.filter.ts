// Turns every error into the API envelope `{ error: { code, message, reason?, details? } }`
// with the message from the catalog (D-08 B03 AC4). Unknown errors are logged without request
// data and returned as `internal`.
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
  type Logger,
} from '@nestjs/common';
import type { ApprovalRefusal } from '@sdlc/contracts';
import type { DecisionViolation } from '@sdlc/core';
import { t, type MessageKey } from '@sdlc/messages';

import { ApiError, errorMessageKey, toApiError } from './api-error.js';
import { localeOf } from './locale.js';

interface Reply {
  status(code: number): Reply;
  send(body: unknown): void;
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Pick<Logger, 'error'>) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const error = fromNest(exception) ?? toApiError(exception);
    if (error.code === 'internal') {
      this.logger.error(
        `unexpected error: ${exception instanceof Error ? exception.name : typeof exception}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    const locale = localeOf(request.headers['accept-language']);
    http
      .getResponse<Reply>()
      .status(error.status)
      .send({
        error: {
          code: error.code,
          message: t(errorMessageKey(error.code), {}, locale),
          ...(error.reason === undefined
            ? {}
            : { reason: error.reason, reason_message: reasonMessage(error.reason, locale) }),
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
  }
}

/** Nest's own exceptions: unknown route (404), bad JSON (400), wrong method… */
function fromNest(exception: unknown): ApiError | undefined {
  if (!(exception instanceof HttpException)) return undefined;
  const status = exception.getStatus();
  if (status === 404) return new ApiError(404, 'not_found');
  if (status === 429) return new ApiError(429, 'rate_limited');
  if (status >= 400 && status < 500) return new ApiError(status, 'invalid_request');
  return new ApiError(500, 'internal');
}

type RefusalReason = ApprovalRefusal | DecisionViolation;

/** Catalog keys of the refusal reasons of the policy engine and the registry. */
export const REASON_MESSAGE_KEYS: Readonly<Record<RefusalReason, MessageKey>> = {
  actor_not_human: 'api.reason.actor_not_human',
  producer: 'api.reason.producer',
  no_human_decision: 'api.reason.no_human_decision',
  role_missing: 'api.reason.role_missing',
  already_approved: 'api.reason.already_approved',
  role_already_covered: 'api.reason.role_already_covered',
  approvals_complete: 'api.reason.approvals_complete',
  agent_never_decides: 'api.reason.agent_never_decides',
  decision_not_for_actor: 'api.reason.decision_not_for_actor',
  reason_required: 'api.reason.reason_required',
  hitl_needs_a_person: 'api.reason.hitl_needs_a_person',
  breach_never_passes: 'api.reason.breach_never_passes',
};

/** Catalog text of a refusal reason; the code itself for a reason without a key. */
export function reasonMessage(reason: string, locale: string): string {
  const key = Object.hasOwn(REASON_MESSAGE_KEYS, reason)
    ? REASON_MESSAGE_KEYS[reason as RefusalReason]
    : undefined;
  return key === undefined ? reason : t(key, {}, locale);
}
