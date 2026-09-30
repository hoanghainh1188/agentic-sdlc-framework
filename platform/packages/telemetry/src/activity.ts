// Temporal activities: one span and one log context per activity (D-08 A08 AC1–AC2, design/
// ADR-M35 §2.6). Our own small interceptor instead of `@temporalio/interceptors-opentelemetry`,
// which pins the 1.x OpenTelemetry SDK and needs a workflow part inside the workflow bundle.
//
// Always installed: with tracing off the span is a no-op, and the log context still gives every
// log line of the activity its tenant_id, intent_id and run_id.
//
// This package imports `@sdlc/core` for types only: the apps load it before `pg` (tracing.ts), so
// the log context function is passed in (`withLogContext` of `@sdlc/core`).
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { LogContext } from '@sdlc/core';

import { platformTracer } from './tracing.js';

/** The part of Temporal's activity context the interceptor reads (structural, no SDK import). */
export interface ActivityInfoLike {
  readonly activityType: string;
  readonly attempt: number;
  readonly taskQueue: string;
}

export interface ActivityExecuteInputLike {
  readonly args: unknown[];
}

export interface ActivityInboundLike {
  execute<I extends ActivityExecuteInputLike>(
    input: I,
    next: (input: I) => Promise<unknown>,
  ): Promise<unknown>;
}

/** Same shape as Temporal's `ActivityInterceptorsFactory`. */
export type ActivityTracingFactory = (ctx: { readonly info: ActivityInfoLike }) => {
  readonly inbound: ActivityInboundLike;
};

/** Reads the IDs of an activity from its arguments. */
export type ActivityContextOf = (activityType: string, args: readonly unknown[]) => LogContext;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function id(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

/**
 * Default: the first argument's `tenantId`, `intentId` and `runId` (the platform's activity inputs
 * are IDs only, ADR-M30 and ADR-M33), and a second UUID argument as the run
 * (`finishRun(ref, runId)`). Values that are not UUIDs are ignored.
 */
export const defaultActivityContext: ActivityContextOf = (_type, args) => {
  const first = args[0];
  const ref = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {};
  const runId = id(ref.runId) ?? id(args[1]);
  const tenantId = id(ref.tenantId);
  const intentId = id(ref.intentId);
  return {
    ...(tenantId ? { tenantId } : {}),
    ...(intentId ? { intentId } : {}),
    ...(runId ? { runId } : {}),
  };
};

/** `withLogContext` of `@sdlc/core`. */
export type WithLogContext = <T>(context: LogContext, fn: () => T) => T;

export interface ActivityTracingOptions {
  readonly withLogContext: WithLogContext;
  readonly contextOf?: ActivityContextOf;
}

export function activityTracingInterceptor(
  options: ActivityTracingOptions,
): ActivityTracingFactory {
  const contextOf = options.contextOf ?? defaultActivityContext;
  return ({ info }) => ({
    inbound: {
      execute(input, next) {
        const ids = contextOf(info.activityType, input.args);
        return options.withLogContext(ids, () =>
          platformTracer().startActiveSpan(
            `activity ${info.activityType}`,
            {
              kind: SpanKind.INTERNAL,
              attributes: {
                'temporal.activity.type': info.activityType,
                'temporal.activity.attempt': info.attempt,
                'temporal.task_queue': info.taskQueue,
                ...(ids.tenantId ? { 'sdlc.tenant_id': ids.tenantId } : {}),
                ...(ids.intentId ? { 'sdlc.intent_id': ids.intentId } : {}),
                ...(ids.runId ? { 'sdlc.run_id': ids.runId } : {}),
              },
            },
            async (span) => {
              try {
                return await next(input);
              } catch (error) {
                // The error's class only: a message may hold text from elsewhere.
                span.setStatus({ code: SpanStatusCode.ERROR });
                span.setAttribute(
                  'error.type',
                  error instanceof Error ? error.constructor.name : 'unknown',
                );
                throw error;
              } finally {
                span.end();
              }
            },
          ),
        );
      },
    },
  });
}
