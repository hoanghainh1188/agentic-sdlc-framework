// X01 spike (design/ADR-M68): shared parts of the two spike adapters. Thrown away after X01.
// They reuse the pure helpers (task message, git commands, loop keys), now in `@sdlc/agent-kit`
// (X03 PR 2, ADR-M88 §2.3).
import { AgentError, type RunContract, type StartAgentRun } from '@sdlc/contracts';
import { buildTaskMessage, checkTask, toolsOf } from '@sdlc/agent-kit';

/** The task message of ADR-M29 §2.2 with the agent's own way to say it is done. */
export function taskMessage(input: StartAgentRun, finishRule: string): string {
  return buildTaskMessage(input.contract, input.task, input.workingDir, { finishRule });
}

/** The checks every adapter makes before it starts (ADR-M29 §2.2). */
export function checkStart(input: StartAgentRun): readonly string[] {
  if (!input.contract.allowed_models.includes(input.model.model)) {
    throw new AgentError('model_not_allowed');
  }
  checkTask(input.contract, input.task);
  return toolsOf(input.contract);
}

export interface HttpOptions {
  readonly baseUrl: string;
  readonly authorization: string;
  readonly timeoutMs: number;
}

/** JSON over HTTP with the run's session key; errors are codes, never server text. */
export async function call<T>(
  options: HttpOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: options.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (e) {
    throw new AgentError(e instanceof DOMException ? 'timeout' : 'network_error');
  }
  if (res.status === 401) throw new AgentError('unauthorized');
  if (res.status === 404) throw new AgentError('not_found');
  if (!res.ok) throw new AgentError('server_error', { status: res.status });
  const text = await res.text();
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AgentError('invalid_response');
  }
}

export const capsOf = (contract: RunContract) => ({
  maxIterations: contract.max_iterations,
  maxDurationMin: contract.max_duration_min,
});
