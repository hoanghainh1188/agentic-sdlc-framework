// Loop detection inputs (D-02 FR-35, D-08 C11 AC3, ADR-M42 §2.7). Ported from the C01 spike's
// loop detector (ADR-M10 §4.1 item 2). Two identical tool calls are the same tool
// with the same SHA-256 of the RFC 8785 canonical arguments, volatile fields left out. The adapter
// returns counts only: the arguments are client data (commands, paths) and the hashes stay here.
import { createHash } from 'node:crypto';

/** One agent step = one tool call. */
const ACTION_EVENT = 'ActionEvent';

/**
 * Deeper values compare as one marker: the agent's input could be nested deeper than the stack
 * allows (code review of C11 PR 2). Real tool arguments are a few levels deep.
 */
const MAX_DEPTH = 64;

/** Fields that change between otherwise identical calls and must not break the comparison. */
const VOLATILE_FIELDS = new Set(['summary', 'security_risk', 'kind']);

/**
 * RFC 8785 canonical JSON, the same output as `canonicalJson` of `@sdlc/config` for JSON data
 * (adapters import `@sdlc/contracts` only). Unlike that module it never throws: the input is
 * the agent's, so a lone surrogate is made well formed and anything that is not JSON becomes
 * `null`. That only affects the comparison, never what the agent did.
 */
export function canonicalArguments(value: unknown, dropVolatile = true, depth = 0): string {
  if (value === null || value === undefined) return 'null';
  if (depth > MAX_DEPTH) return '"[too deep]"';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'string':
      return JSON.stringify(value.toWellFormed());
    case 'object': {
      if (Array.isArray(value)) {
        const items = value.map((item) => canonicalArguments(item, dropVolatile, depth + 1));
        return `[${items.join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>).filter(
        ([key, v]) => v !== undefined && !(dropVolatile && VOLATILE_FIELDS.has(key)),
      );
      // RFC 8785 §3.2.3: sort by UTF-16 code units (the default string order in JavaScript).
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const members = entries.map(
        ([key, v]) =>
          `${JSON.stringify(key.toWellFormed())}:${canonicalArguments(v, dropVolatile, depth + 1)}`,
      );
      return `{${members.join(',')}}`;
    }
    default:
      return 'null';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArguments(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

/**
 * Comparison key of one tool call: the tool and the SHA-256 of its canonical arguments. Uses the
 * raw tool-call arguments (string or object) when present, else the parsed action.
 */
export function toolCallKey(event: Readonly<Record<string, unknown>>): string {
  const toolCall = isRecord(event.tool_call) ? event.tool_call : undefined;
  const args = toolCall?.arguments;
  const source = args === undefined ? (event.action ?? {}) : parseArguments(args);
  const tool = typeof event.tool_name === 'string' ? event.tool_name : '';
  let canonical: string;
  try {
    canonical = canonicalArguments(source);
  } catch {
    // Never fail a status read on the agent's input: compare the raw text instead.
    canonical = `raw:${typeof args === 'string' ? args.toWellFormed() : ''}`;
  }
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${tool}|${digest}`;
}

/** Number of identical tool calls in a row at the end of the log (0 without any call). */
export function trailingIdenticalCalls(
  events: readonly Readonly<Record<string, unknown>>[],
): number {
  let key: string | undefined;
  let count = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.kind !== ACTION_EVENT) continue;
    const current = toolCallKey(event);
    if (key === undefined) key = current;
    else if (current !== key) break;
    count += 1;
  }
  return count;
}
