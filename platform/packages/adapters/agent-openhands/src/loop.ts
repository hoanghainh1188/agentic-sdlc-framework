// Loop detection inputs (D-02 FR-35, D-08 C11 AC3, ADR-M42 §2.7). Ported from the C01 spike's
// loop detector (ADR-M10 §4.1 item 2). The key of a tool call is shared by every adapter
// (`callKey` of `@sdlc/agent-kit`, ADR-M88 §2.3). The adapter returns counts only: the arguments
// are client data (commands, paths) and the hashes stay here.
import { callKey, trailingEqual } from '@sdlc/agent-kit';

/** One agent step = one tool call. */
const ACTION_EVENT = 'ActionEvent';

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
  return callKey(tool, source);
}

/** Number of identical tool calls in a row at the end of the log (0 without any call). */
export function trailingIdenticalCalls(
  events: readonly Readonly<Record<string, unknown>>[],
): number {
  return trailingEqual(events.filter((e) => e.kind === ACTION_EVENT).map(toolCallKey));
}
