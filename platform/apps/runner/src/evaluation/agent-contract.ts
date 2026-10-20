// The Run Contract view the agent adapter needs for an evaluation run (task L04, ADR-M81 §2.2). An
// evaluation run has no intent, plan or branch to push, but the adapter (and the agent's prompt)
// is built for a `RunContract`. This builds one from the signed evaluation contract and the
// prepared base, in memory only: it is never stored, never signed and never sent anywhere. The IDs
// of the evaluation stand in for the intent and the plan; the branch is a fixed local name that
// nothing pushes.
import { validateRunContract, type EvaluationRunContract, type RunContract } from '@sdlc/contracts';

/** The local branch the agent works on in its sandbox; the runner never pushes it. */
export const EVALUATION_AGENT_BRANCH = 'agent/INT-0000-0000';

/**
 * The tools of the agent in an evaluation, as the L02 harness gave them (ADR-M78, ADR-M29): for
 * an operator evaluation (L04) and for configurations stored before L09. An evaluation of a plan
 * gives the agent its own `allowed_tools` (L09, QUESTIONS #501).
 */
export const EVALUATION_AGENT_TOOLS = ['file_editor', 'terminal'] as const;

export interface AgentContractInput {
  readonly contract: EvaluationRunContract;
  /** The commit of the prepared base the agent starts from. */
  readonly baseSha: string;
  /** The task's plan: the files the agent may change. */
  readonly plannedFiles: readonly string[];
  /** SHA-256 of the instructions the agent reads. */
  readonly instructionsSha256: string;
  /** The configuration's tools (L09); default `EVALUATION_AGENT_TOOLS`. */
  readonly allowedTools?: readonly string[];
}

export class AgentContractError extends Error {
  override readonly name = 'AgentContractError';
}

export function agentContractOf(input: AgentContractInput): RunContract {
  const { contract } = input;
  const draft: RunContract = {
    schema_version: 1,
    run_id: contract.evaluation_run_id,
    intent_id: contract.evaluation_id,
    tenant_id: contract.tenant_id,
    project_id: contract.project_id,
    repo: contract.repo,
    base_sha: input.baseSha,
    branch: EVALUATION_AGENT_BRANCH,
    plan_id: contract.evaluation_id,
    plan_sha256: input.instructionsSha256,
    planned_files: [...input.plannedFiles],
    agent_id: contract.evaluation_id,
    agent_version: contract.agent_version,
    instructions_sha256: input.instructionsSha256,
    allowed_tools: [...(input.allowedTools ?? EVALUATION_AGENT_TOOLS)],
    autonomy_level: 'L2',
    max_budget_usd: contract.max_budget_usd,
    max_iterations: contract.max_iterations,
    max_duration_min: contract.max_duration_min,
    loop_threshold: contract.loop_threshold,
    allowed_models: [...contract.allowed_models],
    egress_allowlist: [...contract.egress_allowlist],
    issued_at: contract.issued_at,
    expires_at: contract.expires_at,
  };
  const checked = validateRunContract(draft);
  if (!checked.ok) throw new AgentContractError(`field ${checked.field}`);
  return checked.contract;
}
