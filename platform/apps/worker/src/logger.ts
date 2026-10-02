// Structured JSON log lines of the worker (tasks B06, A08; design/ADR-M35). The platform logger of
// `@sdlc/core`: one logger serves the loops, the activities, the GitHub adapter and the OpenBao
// client. Events are codes; fields hold IDs, codes, counts and times only, never comment text,
// tokens or keys. Each line also carries the tenant_id, intent_id and run_id of its context, and the
// trace and span IDs when tracing is on.
import { createJsonLogger, type LogFields, type LogLevel, type PlatformLogger } from '@sdlc/core';
import { activeTraceIds } from '@sdlc/telemetry';

export type { LogFields, LogLevel };
export type WorkerLogger = PlatformLogger;

export function jsonLogger(
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): WorkerLogger {
  return createJsonLogger({ write, now, traceIds: activeTraceIds });
}
