// OpenTelemetry tracing of the platform processes (D-02 NFR-06, D-08 A08, design/ADR-M35).
// Logging: `@sdlc/core` (`createJsonLogger`, `withLogContext`).
export {
  activityTracingInterceptor,
  defaultActivityContext,
  type ActivityContextOf,
  type ActivityExecuteInputLike,
  type ActivityInboundLike,
  type ActivityInfoLike,
  type ActivityTracingOptions,
  type ActivityTracingFactory,
  type WithLogContext,
} from './activity.js';
export { DROPPED_ATTRIBUTES, ScrubbingSpanProcessor, stripQuery, URL_ATTRIBUTES } from './scrub.js';
export { OTEL_ENDPOINT_ENV, parseOtelEndpoint } from './settings.js';
export {
  activeTraceIds,
  PLATFORM_TRACER,
  platformInstrumentations,
  platformTracer,
  startTracing,
  type StartTracingOptions,
  type Tracing,
} from './tracing.js';
