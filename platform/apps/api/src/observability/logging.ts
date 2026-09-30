// Logs of the api (D-08 A08 AC1, design/ADR-M35 §2.1–§2.2): the platform JSON logger, and an
// adapter so Nest's own messages and `Logger` instances write the same lines.
import type { LoggerService } from '@nestjs/common';
import { createJsonLogger, type PlatformLogger } from '@sdlc/core';
import { activeTraceIds } from '@sdlc/telemetry';

/** The api's JSON lines on stdout, with the IDs of the request's context and span. */
export function createApiLogger(write: (line: string) => void = (l) => process.stdout.write(l)) {
  return createJsonLogger({ write, traceIds: activeTraceIds });
}

function text(message: unknown): string {
  return typeof message === 'string' ? message : `(${typeof message})`;
}

/**
 * Nest's logger interface on top of the platform logger. Only warnings and errors are written
 * (like the `['error', 'warn']` levels before A08); stacks are never written: they may quote data.
 */
export class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: PlatformLogger) {}

  log(): void {
    // Nest's start-up messages (routes, modules): not written.
  }

  warn(message: unknown, context?: unknown): void {
    this.write('warn', message, context);
  }

  error(message: unknown, ...rest: unknown[]): void {
    // Nest calls error(message, stack?, context?): the context is the last string argument.
    const context = rest.length > 0 ? rest[rest.length - 1] : undefined;
    this.write('error', message, rest.length > 1 ? context : undefined);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.error(message, ...rest);
  }

  private write(level: 'warn' | 'error', message: unknown, context: unknown): void {
    this.logger.log(level, 'api.log', {
      message: text(message),
      ...(typeof context === 'string' ? { source: context } : {}),
    });
  }
}
