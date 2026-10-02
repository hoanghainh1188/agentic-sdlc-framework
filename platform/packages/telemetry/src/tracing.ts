// OpenTelemetry tracing of a platform process (D-08 A08 AC2, design/ADR-M35 §2.3–§2.5).
//
// - Off by default: without an endpoint nothing starts, and `@opentelemetry/api` stays a no-op.
// - Spans go over OTLP/HTTP to the collector (profile `observability`), which forwards them to
//   Langfuse (QUESTIONS #4). The collector holds the Langfuse key; the processes hold none.
// - Instrumentations: `http` (incoming api requests, outgoing calls) and `pg`. They are
//   registered here, so this must run before the process loads `pg`, `fastify` or `node:http`
//   users: each app imports its `telemetry.ts` first.
// - What spans never hold: header values, query strings, SQL parameter values (`scrub.ts`).
import { context, trace, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { TraceIds } from '@sdlc/core';

import { ScrubbingSpanProcessor } from './scrub.js';

/** Name of the tracer used for the platform's own spans (Temporal activities). */
export const PLATFORM_TRACER = '@sdlc/telemetry';

/** Incoming requests that are never traced: health checks run every few seconds. */
const IGNORED_INCOMING_PATHS = /^\/health(\/|$)/;

export interface StartTracingOptions {
  /** `service.name` of the spans: `sdlc-api`, `sdlc-worker`, `sdlc-runner`. */
  readonly serviceName: string;
  /** OTLP/HTTP base URL (`parseOtelEndpoint`); `/v1/traces` is added. Undefined: tracing off. */
  readonly endpoint: string | undefined;
  /** Tests: export here instead of OTLP, without batching. */
  readonly exporter?: SpanExporter;
}

export interface Tracing {
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

/** The instrumentations with their safe configuration. Exported for tests. */
export function platformInstrumentations(): Instrumentation[] {
  return [
    new HttpInstrumentation({
      // No header is ever recorded (the default); stated here so a change is visible in review.
      headersToSpanAttributes: { client: {}, server: {} },
      ignoreIncomingRequestHook: (request) => IGNORED_INCOMING_PATHS.test(request.url ?? ''),
    }),
    new PgInstrumentation({
      // SQL text with $n placeholders only, never the values (condition 2 of the plan approval).
      enhancedDatabaseReporting: false,
      addSqlCommenterCommentToQueries: false,
      // Queries of the background loops outside a request or activity make no root spans.
      requireParentSpan: true,
      ignoreConnectSpans: true,
    }),
  ];
}

/**
 * Starts tracing for this process, or does nothing when `endpoint` is undefined and no test
 * exporter is given. Call it once, before the process loads the instrumented modules.
 */
export function startTracing(options: StartTracingOptions): Tracing | undefined {
  if (options.endpoint === undefined && options.exporter === undefined) return undefined;
  const exporter =
    options.exporter ?? new OTLPTraceExporter({ url: `${options.endpoint ?? ''}/v1/traces` });
  const exportProcessor: SpanProcessor = options.exporter
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName }),
    // The scrubber runs first, so the exporter never sees what it removes.
    spanProcessors: [new ScrubbingSpanProcessor(), exportProcessor],
  });
  provider.register();
  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: platformInstrumentations(),
  });
  return {
    forceFlush: () => provider.forceFlush(),
    async shutdown() {
      unregister();
      await provider.shutdown();
      trace.disable();
      context.disable();
    },
  };
}

export function platformTracer(): Tracer {
  return trace.getTracer(PLATFORM_TRACER);
}

/** IDs of the active span, for the log line (`createJsonLogger({ traceIds })`). */
export function activeTraceIds(): TraceIds | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const { traceId, spanId, traceFlags } = span.spanContext();
  // Not sampled (or tracing off): the IDs point to nothing in Langfuse.
  if ((traceFlags & 1) === 0) return undefined;
  return { traceId, spanId };
}
