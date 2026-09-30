// The api's logs (D-08 A08 AC1, design/ADR-M35 §2.2): the tenant context of a request and Nest's
// messages as JSON lines.
import { firstValueFrom, Observable } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { LogContextInterceptor } from '../../apps/api/src/observability/log-context.interceptor.js';
import { NestJsonLogger } from '../../apps/api/src/observability/logging.js';

type ExecutionContext = Parameters<LogContextInterceptor['intercept']>[0];
type CallHandler = Parameters<LogContextInterceptor['intercept']>[1];
import {
  createJsonLogger,
  currentLogContext,
  type LogContext,
} from '../../packages/core/src/observability/index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

function executionContext(principal?: { tenantId: string }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;
}

/** A handler that reports the log context it runs in, after an await (like a real handler). */
function handler(): CallHandler {
  return {
    handle: () =>
      new Observable<LogContext>((subscriber) => {
        void Promise.resolve().then(() => {
          subscriber.next(currentLogContext());
          subscriber.complete();
        });
      }),
  };
}

describe('LogContextInterceptor', () => {
  it('runs the handler with the caller tenant in the log context', async () => {
    const seen = await firstValueFrom(
      new LogContextInterceptor().intercept(executionContext({ tenantId: TENANT }), handler()),
    );
    expect(seen).toEqual({ tenantId: TENANT });
  });

  it('adds nothing on public routes', async () => {
    const seen = await firstValueFrom(
      new LogContextInterceptor().intercept(executionContext(), handler()),
    );
    expect(seen).toEqual({});
  });
});

describe('NestJsonLogger', () => {
  function capture() {
    const lines: Record<string, unknown>[] = [];
    const nest = new NestJsonLogger(
      createJsonLogger({
        write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      }),
    );
    return { nest, lines };
  }

  it('writes warnings and errors as JSON lines, without the stack', () => {
    const { nest, lines } = capture();
    nest.warn('slow start', 'NestApplication');
    nest.error('unexpected error: TypeError', 'TypeError: x\n    at secret-path.ts:1', 'sdlc-api');
    nest.error('only a message');
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'api.log',
        message: 'slow start',
        source: 'NestApplication',
      }),
      expect.objectContaining({
        level: 'error',
        event: 'api.log',
        message: 'unexpected error: TypeError',
        source: 'sdlc-api',
      }),
      expect.objectContaining({ level: 'error', message: 'only a message' }),
    ]);
    expect(JSON.stringify(lines)).not.toContain('secret-path');
    expect(lines[2]).not.toHaveProperty('source');
  });

  it('drops start-up messages and writes no object content', () => {
    const { nest, lines } = capture();
    nest.log();
    nest.warn({ token: 'x' });
    expect(lines).toEqual([expect.objectContaining({ message: '(object)' })]);
  });
});
