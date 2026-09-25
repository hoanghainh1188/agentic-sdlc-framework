// Loop detection for FR-35 (C01 spike, de-risks C11). The platform runs its own check on the
// Agent Server's ActionEvents, because OpenHands' built-in stuck detector has fixed thresholds
// that the REST API cannot change. The limit comes from project config:
// `run.loop_detection.identical_tool_calls_max` (handbook Ch.3 §3.6: more than 3 → stop).

export interface ActionLike {
  kind?: string;
  tool_name?: string;
  tool_call?: { arguments?: unknown } | null;
  action?: Record<string, unknown> | null;
}

/** Fields that change between otherwise identical calls and must not break the comparison. */
const VOLATILE_ACTION_FIELDS = new Set(['summary', 'security_risk', 'kind']);

/** JSON with sorted keys and volatile fields removed, so equal calls give equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !VOLATILE_ACTION_FIELDS.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
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
 * Comparison key of one tool call. Uses the raw tool-call arguments (string or object) when
 * present, else the parsed action; both are canonicalised the same way.
 */
export function actionKey(event: ActionLike): string {
  const args = event.tool_call?.arguments;
  const source = args === undefined ? (event.action ?? {}) : parseArguments(args);
  return `${event.tool_name ?? ''}|${canonical(source)}`;
}

/** Length of the run of identical tool calls at the end of the event list. */
export function trailingIdenticalCalls(events: readonly ActionLike[]): number {
  const actions = events.filter((e) => e.kind === 'ActionEvent');
  const last = actions.at(-1);
  if (!last) return 0;
  const key = actionKey(last);
  let count = 0;
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const action = actions[i];
    if (!action || actionKey(action) !== key) break;
    count += 1;
  }
  return count;
}

/** True when there are more than `maxIdentical` identical consecutive tool calls. */
export function isLooping(events: readonly ActionLike[], maxIdentical: number): boolean {
  return trailingIdenticalCalls(events) > maxIdentical;
}
