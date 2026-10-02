// Tracing of the worker (D-08 A08 AC2, design/ADR-M35 §2.3). Imported FIRST by main.ts: the
// instrumentations must be registered before `pg` and the HTTP clients are loaded. The endpoint is
// read here, before the settings module; main.ts refuses to start when it is not valid.
import { OTEL_ENDPOINT_ENV, parseOtelEndpoint, startTracing, type Tracing } from '@sdlc/telemetry';

export const SERVICE_NAME = 'sdlc-worker';

const endpoint = parseOtelEndpoint(process.env[OTEL_ENDPOINT_ENV]);

/** False when `SDLC_OTEL_ENDPOINT` is set but not valid (main.ts stops with a setting error). */
export const tracingEndpointValid = endpoint !== null;

export const tracing: Tracing | undefined = startTracing({
  serviceName: SERVICE_NAME,
  endpoint: endpoint ?? undefined,
});
