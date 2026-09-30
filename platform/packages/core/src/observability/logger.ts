// The platform logger (task A08, design/ADR-M35 §2.1): one JSON line per event, with the IDs of
// the current context (tenant_id, intent_id, run_id) and, when tracing is on, the trace and span
// IDs. Same rules as the audit log: events are codes, fields hold IDs, codes, counts and times.
// The field guard below is a second line of defence: it drops fields whose name suggests a
// secret or free text, keeps values flat and cuts long strings.
import { currentLogContext } from './context.js';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, string | number | boolean>>;

/** The shape shared with the worker, the Cost Controller and the OpenBao client hooks. */
export interface PlatformLogger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

export interface TraceIds {
  readonly traceId: string;
  readonly spanId: string;
}

export interface JsonLoggerOptions {
  readonly write: (line: string) => void;
  readonly now?: () => Date;
  /** The active span's IDs (`@sdlc/telemetry`), or undefined when tracing is off. */
  readonly traceIds?: () => TraceIds | undefined;
}

/** Longest string value kept in a field; longer values are cut. */
export const MAX_LOG_STRING_LENGTH = 500;

/**
 * Words that drop a field when its name contains them (`installation_token`, `apiKey`,
 * `comment_text`): secrets and free text never go into a log line. Names are split into words at
 * `_`, `-`, `.` and camelCase, so `context_id` or `tokens_in` stay. `message` is allowed: it holds
 * catalog text only.
 */
export const DENIED_LOG_WORDS: ReadonlySet<string> = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'authorization',
  'authorisation',
  'auth',
  'bearer',
  'jwt',
  'cookie',
  'session',
  'key',
  'credential',
  'credentials',
  'body',
  'text',
  'comment',
  'prompt',
  'content',
  'header',
  'headers',
  'url',
  'uri',
  'query',
  'value',
]);

/** Words of a field name, lower case: `apiKey` → `api`, `key`; `secret_id` → `secret`, `id`. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_.-]+/)
    .filter((word) => word !== '');
}

/** True when the field is dropped by the guard. Exported for tests. */
export function isDeniedLogField(name: string): boolean {
  return wordsOf(name).some((word) => DENIED_LOG_WORDS.has(word));
}

/** Keys the logger writes itself; a field cannot replace them. */
const RESERVED = new Set(['time', 'level', 'event', 'trace_id', 'span_id', 'dropped_fields']);

export interface SafeFields {
  readonly fields: Record<string, string | number | boolean>;
  readonly dropped: number;
}

/** Applies the field guard. Exported for tests. */
export function safeLogFields(fields: LogFields | undefined): SafeFields {
  const kept: Record<string, string | number | boolean> = {};
  let dropped = 0;
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (RESERVED.has(name) || isDeniedLogField(name)) {
      dropped += 1;
      continue;
    }
    if (typeof value === 'string') {
      kept[name] =
        value.length > MAX_LOG_STRING_LENGTH ? value.slice(0, MAX_LOG_STRING_LENGTH) : value;
    } else if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      kept[name] = value;
    } else {
      dropped += 1;
    }
  }
  return { fields: kept, dropped };
}

export function createJsonLogger(options: JsonLoggerOptions): PlatformLogger {
  const now = options.now ?? (() => new Date());
  return {
    log(level, event, fields) {
      const context = currentLogContext();
      const trace = options.traceIds?.();
      const safe = safeLogFields(fields);
      const line = {
        time: now().toISOString(),
        level,
        event,
        ...(context.tenantId === undefined ? {} : { tenant_id: context.tenantId }),
        ...(context.intentId === undefined ? {} : { intent_id: context.intentId }),
        ...(context.runId === undefined ? {} : { run_id: context.runId }),
        ...(trace ? { trace_id: trace.traceId, span_id: trace.spanId } : {}),
        // An explicit field (for example the poller's tenant_id) is more precise than the context.
        ...safe.fields,
        ...(safe.dropped > 0 ? { dropped_fields: safe.dropped } : {}),
      };
      options.write(`${JSON.stringify(line)}\n`);
    },
  };
}

export const silentPlatformLogger: PlatformLogger = { log: () => undefined };
