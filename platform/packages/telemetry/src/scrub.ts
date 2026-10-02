// Removes what must never leave the process in a span (design/ADR-M35 §2.5, condition 2 of the
// plan approval): header values, query strings (they can hold tokens), SQL parameter values, and
// error texts (a status message or an exception event can quote a value, for example PostgreSQL's
// `invalid input syntax for type uuid: "<value>"`).
// The instrumentations are configured not to record them; this processor runs on every span just
// before it ends, so a later instrumentation or SDK default cannot bring them back.
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/** Attributes whose value is a URL or a request target: the query string is removed. */
export const URL_ATTRIBUTES: readonly string[] = [
  'url.full',
  'http.url',
  'http.target',
  'url.original',
];

/** Attributes removed entirely. */
export const DROPPED_ATTRIBUTES = new RegExp(
  [
    '^url\\.query$',
    // Header values, both semantic-convention generations.
    '^http\\.(request|response)\\.header\\.',
    '\\.headers?$',
    // SQL parameter values (enhanced database reporting).
    '^db\\.postgresql\\.values$',
    '^db\\.query\\.parameter\\.',
    '^db\\.statement\\.parameters$',
  ].join('|'),
);

export function stripQuery(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/** Event attributes kept: the error class only, never its message or stack. */
const KEPT_EVENT_ATTRIBUTES = new Set(['exception.type']);

/** The mutable fields of an SDK span; they stay mutable until the span has ended. */
interface MutableSpan {
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: { name: string; attributes?: Record<string, unknown> }[];
}

export class ScrubbingSpanProcessor implements SpanProcessor {
  onStart(): void {
    // Nothing: attributes may still change until the span ends.
  }

  onEnding(span: Span): void {
    const mutable = span as unknown as MutableSpan;
    // The status keeps its code (OK, ERROR) but never the error text.
    if (mutable.status.message !== undefined) mutable.status = { code: mutable.status.code };
    for (const event of mutable.events) {
      if (event.attributes === undefined) continue;
      event.attributes = Object.fromEntries(
        Object.entries(event.attributes).filter(([name]) => KEPT_EVENT_ATTRIBUTES.has(name)),
      );
    }
    const attributes = mutable.attributes;
    for (const name of Object.keys(attributes)) {
      if (DROPPED_ATTRIBUTES.test(name)) {
        delete attributes[name];
        continue;
      }
      const value = attributes[name];
      if (URL_ATTRIBUTES.includes(name) && typeof value === 'string') {
        attributes[name] = stripQuery(value);
      }
    }
  }

  onEnd(): void {
    // Nothing: the export processor comes after this one.
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
