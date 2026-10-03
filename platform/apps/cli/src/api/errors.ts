// API failures → message and exit code (design/ADR-M36 §2.5). The API's error codes and refusal
// reasons are rendered from the shared catalog (`api.error.<code>`, `gate.reason.<reason>`); the
// server's own text is used only for a code this CLI does not know yet.
import { isRefusalReason, refusalReasonMessage } from '@sdlc/core';
import { catalogFor, DEFAULT_LOCALE, type MessageKey } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';
import { clean, sayError, toJson } from '../output.js';
import { ApiCallError, type ApiFailureKind } from './client.js';

const KIND_KEYS: Readonly<Record<Exclude<ApiFailureKind, 'http'>, MessageKey>> = {
  network: 'cli.api.network',
  timeout: 'cli.api.timeout',
  redirect: 'cli.api.redirect',
  too_large: 'cli.api.too_large',
  malformed: 'cli.api.malformed',
};

/** Exit code of a failed call: 4 authentication, 2 bad request, 1 refused, 3 everything else. */
export function exitCodeOf(error: ApiCallError): number {
  if (error.kind !== 'http' || error.status === undefined) return EXIT.error;
  if (error.status === 401) return EXIT.auth;
  if (error.status === 400) return EXIT.usage;
  if (error.status >= 500) return EXIT.error;
  return EXIT.failed;
}

/** Prints a failed call (human or JSON, on stderr) and returns its exit code. */
export function reportApiFailure(ctx: CliContext, error: ApiCallError, json: boolean): number {
  const exit = exitCodeOf(error);
  if (json) {
    ctx.stderr(
      toJson(
        error.envelope ?? {
          error: {
            code: `cli_${error.kind}`,
            message: messageOfKind(error),
            ...(error.status === undefined ? {} : { status: error.status }),
          },
        },
      ),
    );
    return exit;
  }
  if (error.kind !== 'http') {
    ctx.stderr(messageOfKind(error));
  } else if (error.envelope === undefined) {
    sayError(ctx, 'cli.api.http_status', { status: error.status ?? 0 });
  } else {
    const { code, message, reason, reason_message, details } = error.envelope.error;
    sayError(ctx, 'cli.api.refused', { code, message: apiErrorMessage(code) ?? clean(message) });
    if (reason !== undefined) {
      const text = isRefusalReason(reason)
        ? refusalReasonMessage(reason)
        : (reason_message ?? reason);
      sayError(ctx, 'cli.api.reason', { reason, message: text });
    }
    // A configuration issue (B13) carries its catalog text; other details carry a zod code.
    for (const detail of details ?? []) {
      sayError(ctx, 'cli.api.detail', { path: detail.path, issue: detail.message ?? detail.issue });
    }
  }
  if (exit === EXIT.auth) sayError(ctx, 'cli.api.login_again');
  return exit;
}

function messageOfKind(error: ApiCallError): string {
  if (error.kind === 'http') return '';
  const catalog = catalogFor(DEFAULT_LOCALE);
  const key = KIND_KEYS[error.kind];
  return catalog?.[key] ?? key;
}

/** The catalog text of an API error code, or undefined for a code this CLI does not know. */
function apiErrorMessage(code: string): string | undefined {
  const catalog = catalogFor(DEFAULT_LOCALE) as Readonly<Record<string, string>> | undefined;
  const key = `api.error.${code}`;
  return catalog !== undefined && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
}
