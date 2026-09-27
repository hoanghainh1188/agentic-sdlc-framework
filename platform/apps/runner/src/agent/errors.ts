// Why the runner could not start or drive the agent of a run (C05, ADR-M29). Codes only: they are
// written as `stop_reason` and in the run event `agent_failed`; the texts are in the catalog.
import { RunnerError } from '../errors.js';

export type AgentRunFailure =
  | 'runner_not_attachable' // no runner container configured, or the run's network is gone
  | 'model_unreachable' // LiteLLM is not in the contract's egress list
  | 'task_unavailable' // the plan or the spec of the run cannot be loaded, or they differ
  | 'run_not_running'; // the run is not `running` (not provisioned, or stopped meanwhile)

export class AgentRunError extends RunnerError {
  constructor(readonly reason: AgentRunFailure) {
    super('runner.agent_failed', { reason });
  }
}
