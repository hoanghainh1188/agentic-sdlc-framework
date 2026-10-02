// Structured logging (design/D-02 NFR-06, D-08 A08, design/ADR-M35). Tracing: `@sdlc/telemetry`.
export { currentLogContext, withLogContext, type LogContext } from './context.js';
export {
  createJsonLogger,
  DENIED_LOG_WORDS,
  isDeniedLogField,
  MAX_LOG_STRING_LENGTH,
  safeLogFields,
  silentPlatformLogger,
  type JsonLoggerOptions,
  type LogFields,
  type LogLevel,
  type PlatformLogger,
  type SafeFields,
  type TraceIds,
} from './logger.js';
