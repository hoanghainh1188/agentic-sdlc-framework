// The status of an OpenCode run from its session (design/ADR-M68 §3.1, §6 gaps 1 and 10). Pure.
//
// - One agent step = one `step-finish` part (one model reply). OpenCode reports progress per
//   reply, not per tool call.
// - Loop detection (C11, ADR-M42 §2.7): `events` counts every part; `identicalCalls` compares the
//   `tool` parts with the loop key every adapter shares (`callKey` of `@sdlc/agent-kit`). Counts
//   only: the arguments are client data.
// - The context snapshot (X07, ADR-M90 §2.1): the files the `read` tool opened; `bash`, `grep`,
//   `glob` and `list` can read files without naming them, so they are only counted.
// - The runner never trusts the agent's own limits (gap 1): at the cap the adapter stops the run
//   itself, whatever OpenCode's `steps` says.
import { callKey, fileReadsOf, trailingEqual } from '@sdlc/agent-kit';
import type { AgentFileReads, AgentRunState } from '@sdlc/contracts';

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

const READ_TOOL = 'read';
const UNNAMED_READ_TOOLS = new Set(['bash', 'grep', 'glob', 'list']);

/**
 * The files the `read` tool opened and the number of other calls that can read files.
 * `platformCommands`: the adapter's own shell commands (commit, diff), not counted.
 */
export function fileReadsOfMessages(
  messages: readonly OpenCodeMessage[],
  workingDir: string,
  platformCommands: readonly string[] = [],
): AgentFileReads {
  const paths: string[] = [];
  let unattributed = 0;
  const own = new Set(platformCommands);
  for (const part of messages.flatMap((message) => message.parts)) {
    if (part.type !== TOOL_PART || typeof part.tool !== 'string') continue;
    const command = (part.state?.input as { command?: unknown } | undefined)?.command;
    if (part.tool === 'bash' && typeof command === 'string' && own.has(command)) continue;
    if (UNNAMED_READ_TOOLS.has(part.tool)) {
      unattributed += 1;
      continue;
    }
    const input = part.state?.input as { filePath?: unknown } | undefined;
    if (part.tool === READ_TOOL && typeof input?.filePath === 'string') paths.push(input.filePath);
  }
  return fileReadsOf(paths, workingDir, unattributed);
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
 * - busy or retrying, or idle before the first reply: `running` (also while an abort at the cap
 *   is still in flight);
 * - idle after the adapter stopped it at the cap, or past the cap with no error (OpenCode's own
 *   stop at `steps` = cap + 1): `max_iterations`;
 * - idle after an abort: `stopped`; after any other error: `error`;
 * - idle otherwise: `finished` (OpenCode has no finish tool: the agent stops replying).
 */
export function stateOf(input: StateInput): AgentRunState {
  const assistant = input.messages.filter((message) => message.info.role === 'assistant');
  if (input.session !== 'idle' || assistant.length === 0) return 'running';
  if (input.stoppedAtCap) return 'max_iterations';
  const error = assistant.at(-1)?.info.error;
  if (error !== undefined) return error.name === ABORTED_ERROR ? 'stopped' : 'error';
  return input.iterations > input.cap ? 'max_iterations' : 'finished';
}
