// The status of an OpenCode run from its session (design/ADR-M68 §3.1, §6 gaps 1 and 10). Pure.
//
// - One agent step = one `step-finish` part (one model reply). OpenCode reports progress per
//   reply, not per tool call.
// - Loop detection (C11, ADR-M42 §2.7): `events` counts every part; `identicalCalls` compares the
//   `tool` parts with the loop key every adapter shares (`callKey` of `@sdlc/agent-kit`). Counts
//   only: the arguments are client data.
// - The runner never trusts the agent's own limits (gap 1): at the cap the adapter stops the run
//   itself, whatever OpenCode's `steps` says.
import { callKey, trailingEqual } from '@sdlc/agent-kit';
import type { AgentRunState } from '@sdlc/contracts';

import type { OpenCodeMessage, SessionState } from './client.js';

const STEP_PART = 'step-finish';
const TOOL_PART = 'tool';
/** The error OpenCode records on the last reply after `POST /session/:id/abort`. */
export const ABORTED_ERROR = 'MessageAbortedError';

export interface RunCounts {
  readonly iterations: number;
  readonly events: number;
  readonly identicalCalls: number;
}

export function countsOf(messages: readonly OpenCodeMessage[]): RunCounts {
  const parts = messages.flatMap((message) => message.parts);
  const iterations = parts.filter((part) => part.type === STEP_PART).length;
  const keys = parts
    .filter((part) => part.type === TOOL_PART && typeof part.tool === 'string')
    .map((part) => callKey(part.tool ?? '', part.state?.input ?? {}));
  return { iterations, events: parts.length, identicalCalls: trailingEqual(keys) };
}

export interface StateInput {
  readonly session: SessionState;
  readonly messages: readonly OpenCodeMessage[];
  readonly iterations: number;
  /** The contract's `max_iterations`. */
  readonly cap: number;
  /** True when the adapter stopped the run at the cap. */
  readonly stoppedAtCap: boolean;
}

/**
 * OpenCode session → agent state:
 * - busy or retrying, or idle before the first reply: `running`;
 * - idle after the adapter stopped it at the cap, or at the cap with no error: `max_iterations`;
 * - idle after an abort: `stopped`; after any other error: `error`;
 * - idle otherwise: `finished` (OpenCode has no finish tool: the agent stops replying).
 */
export function stateOf(input: StateInput): AgentRunState {
  const assistant = input.messages.filter((message) => message.info.role === 'assistant');
  if (input.session !== 'idle' || assistant.length === 0) return 'running';
  if (input.stoppedAtCap) return 'max_iterations';
  const error = assistant.at(-1)?.info.error;
  if (error !== undefined) return error.name === ABORTED_ERROR ? 'stopped' : 'error';
  return input.iterations >= input.cap ? 'max_iterations' : 'finished';
}
