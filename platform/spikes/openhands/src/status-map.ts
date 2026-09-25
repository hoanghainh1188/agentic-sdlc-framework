// Maps the Agent Server conversation state to the D-05 `run_status` enum (C01 spike).
// Source of the OpenHands values: `ConversationExecutionStatus` in openapi.json of v1.48.0.

export const EXECUTION_STATUSES = [
  'idle',
  'running',
  'paused',
  'waiting_for_confirmation',
  'finished',
  'error',
  'stuck',
  'deleting',
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** D-05 §5 `run_status` values the adapter can derive from the Agent Server alone. */
export type RunStatus =
  | 'running'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'stopped_timeout'
  | 'stopped_stalled'
  | 'stopped_killed';

/** Why the platform interrupted the run, if it did. */
export type PlatformStopReason = 'kill' | 'loop' | 'timeout';

export interface StatusContext {
  /** Set when the platform itself interrupted the run; undefined otherwise. */
  stopReason?: PlatformStopReason;
}

const STOP_STATUS: Record<PlatformStopReason, RunStatus> = {
  kill: 'stopped_killed',
  loop: 'stopped_stalled',
  timeout: 'stopped_timeout',
};

/**
 * `paused` only comes from our own interrupt, so it is a stop, never success.
 * `waiting_for_confirmation` cannot happen: the PoC starts conversations with no confirmation policy.
 * Budget, scope and time stops (`stopped_budget`, `stopped_scope`, `stopped_timeout`) are decided
 * by the platform (LiteLLM spend, G5, timers), not read from the Agent Server.
 */
export function toRunStatus(status: ExecutionStatus, context: StatusContext): RunStatus {
  switch (status) {
    case 'idle':
    case 'running':
    case 'waiting_for_confirmation':
      return 'running';
    case 'finished':
      return 'succeeded';
    case 'error':
      return 'failed';
    case 'stuck':
      return 'stopped_stalled';
    case 'paused':
      return context.stopReason ? STOP_STATUS[context.stopReason] : 'failed';
    case 'deleting':
      return 'stopping';
  }
}

export function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return typeof value === 'string' && (EXECUTION_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: ExecutionStatus): boolean {
  return status === 'finished' || status === 'error' || status === 'stuck' || status === 'paused';
}
