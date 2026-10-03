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
import { formatIssue } from '@sdlc/config';
import { refusalReasonMessage, withLogContext } from '@sdlc/core';
import { t } from '@sdlc/messages';

import type { AuthenticatedRequest } from '../auth/principal.js';
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
    const request = http.getRequest<
      AuthenticatedRequest & { headers: Record<string, string | string[] | undefined> }
    >();
    const error = fromNest(exception) ?? toApiError(exception);
    if (error.code === 'internal' && !(exception instanceof ApiError)) {
      // The caller's tenant goes into the log line (A08); the filter runs outside the interceptor.
      withLogContext({ tenantId: request.principal?.tenantId }, () =>
        this.logger.error(
          `unexpected error: ${exception instanceof Error ? exception.name : typeof exception}`,
          exception instanceof Error ? exception.stack : undefined,
        ),
      );
    }
    const locale = localeOf(request.headers['accept-language']);
    const details =
      error.configIssues === undefined
        ? error.details
        : error.configIssues.slice(0, 50).map((issue) => ({
            path: issue.path === '' ? 'body.config_yaml' : `body.config_yaml.${issue.path}`,
            issue: issue.key,
            message: formatIssue(issue, locale),
          }));
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
          ...(details === undefined ? {} : { details }),
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

/** Catalog text of a refusal reason (shared with the comment replies, `@sdlc/core`). */
export function reasonMessage(reason: string, locale: string): string {
  return refusalReasonMessage(reason, locale);
}
