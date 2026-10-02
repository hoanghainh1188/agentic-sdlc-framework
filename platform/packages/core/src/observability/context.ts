// Log context of the current request, loop step or activity (task A08, design/ADR-M35 §2.2).
// The IDs follow the async call chain (AsyncLocalStorage), so call sites do not pass them.
import { AsyncLocalStorage } from 'node:async_hooks';

/** IDs only: never a name, a login, a token or text. */
export interface LogContext {
  readonly tenantId?: string;
  readonly intentId?: string;
  readonly runId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** The context of the current async chain; empty outside `withLogContext`. */
export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/**
 * Runs `fn` with the current context plus `context`. A value given here replaces the outer one;
 * an undefined value keeps it. The outer context is never changed.
 */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const outer = currentLogContext();
  const merged: LogContext = {
    ...outer,
    ...(context.tenantId === undefined ? {} : { tenantId: context.tenantId }),
    ...(context.intentId === undefined ? {} : { intentId: context.intentId }),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
  };
  return storage.run(merged, fn);
}
