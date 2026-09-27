// Pure builders for the OpenHands Agent Server 1.48.0 requests (design/ADR-M10 §2.2, ADR-M29).
// Pure, so tests can check exactly what reaches the sandbox.
//
// What the conversation gets:
// - LLM: `litellm_proxy/<model>` on LiteLLM with the run's virtual key (FR-50); the key travels in
//   the request body only, never as a sandbox environment variable.
// - Tools: the contract's `allowed_tools`, which must be in AGENT_TOOLS (ADR-M10 §4.1 item 4).
// - Project instructions: `agent_context.load_project_skills` loads AGENTS.md (and
//   `.openhands/skills/`) from the workspace. User, public and memory skills stay off: public skills
//   would be fetched from GitHub, which the sandbox cannot and must not reach.
// - `max_iterations` from the contract (FR-32); `autotitle: false` (one model call fewer,
//   ADR-M10 §4.1 item 1); OpenHands' own stuck detector on (fixed thresholds; the platform's
//   loop check with the configured limit comes in C11).
// - The first user message: the spec, the plan and the rules of the run (D-08 C05 AC2).
import {
  AGENT_TOOLS,
  AgentError,
  type AgentTask,
  type AgentTool,
  type RunContract,
} from '@sdlc/contracts';

/** Names of project instruction files the agent reads (loaded by `load_project_skills`). */
export const INSTRUCTIONS_FILE = 'AGENTS.md';

export interface ConversationRequestInput {
  readonly contract: RunContract;
  readonly model: string;
  readonly llmBaseUrl: string;
  /** The virtual key, revealed only here. */
  readonly virtualKey: string;
  readonly workingDir: string;
  readonly task: AgentTask;
}

const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./ -]{0,1023}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SUMMARY = 20_000;

function isAgentTool(tool: string): tool is AgentTool {
  return (AGENT_TOOLS as readonly string[]).includes(tool);
}

/** The tools of the run. Refuses a tool the MVP never grants. */
export function toolsOf(contract: RunContract): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const tool of contract.allowed_tools) {
    if (!isAgentTool(tool)) throw new AgentError('tool_not_allowed', { tool });
    tools.push(tool);
  }
  return tools;
}

/** Checks the task against the contract before anything reaches the sandbox. */
export function checkTask(contract: RunContract, task: AgentTask): void {
  const { spec, plan } = task;
  if (
    !SAFE_PATH.test(spec.path) ||
    spec.path.split('/').some((part) => part === '..' || part === '.') ||
    !GIT_SHA.test(spec.commitSha) ||
    !SHA256.test(spec.contentSha256)
  ) {
    throw new AgentError('invalid_input', { field: 'spec' });
  }
  if (typeof plan.summary !== 'string' || plan.summary.length > MAX_SUMMARY) {
    throw new AgentError('invalid_input', { field: 'plan.summary' });
  }
  const planned = contract.planned_files;
  if (
    plan.plannedFiles.length !== planned.length ||
    plan.plannedFiles.some((file, i) => file !== planned[i])
  ) {
    throw new AgentError('invalid_input', { field: 'plan.planned_files' });
  }
}

/**
 * The first user message (D-08 C05 AC2). It points at the spec file instead of copying it: the
 * agent reads it from the workspace, which the runner cloned at `base_sha`. Agent-facing text,
 * not a user-facing message, so it is not in the message catalog (ADR-M29).
 */
export function buildTaskMessage(
  contract: RunContract,
  task: AgentTask,
  workingDir: string,
): string {
  const files = task.plan.plannedFiles.map((file) => `- ${file}`).join('\n');
  return [
    `You work in the Git repository at ${workingDir}, on the branch ${contract.branch}.`,
    '',
    `Project instructions: follow ${INSTRUCTIONS_FILE} at the repository root, if the file exists.`,
    '',
    'Specification (read it first; it is the source of truth for this task):',
    `- file: ${task.spec.path}`,
    `- commit: ${task.spec.commitSha}`,
    `- SHA-256: ${task.spec.contentSha256}`,
    '',
    'Approved plan:',
    task.plan.summary.trim() === '' ? '(no summary)' : task.plan.summary.trim(),
    '',
    'Files and path patterns you may change (the platform stops the run if other files change):',
    files,
    '',
    'Rules:',
    `- Stay on the branch ${contract.branch}. Do not create or switch branches.`,
    '- Do not push, and do not change Git remotes or Git configuration.',
    '- You may commit your work; the platform commits whatever is left when you finish.',
    '- Install dependencies only from the lockfile (for example `pnpm install --frozen-lockfile`).',
    '- When the task is done, call the finish tool with a short summary.',
  ].join('\n');
}

/** Body of `POST /api/conversations` (Agent Server 1.48.0, `StartConversationRequest`). */
export function buildConversationRequest(input: ConversationRequestInput): Record<string, unknown> {
  const { contract } = input;
  if (!contract.allowed_models.includes(input.model)) {
    throw new AgentError('model_not_allowed');
  }
  checkTask(contract, input.task);
  const tools = toolsOf(contract);
  return {
    agent: {
      kind: 'Agent',
      llm: {
        model: `litellm_proxy/${input.model}`,
        base_url: input.llmBaseUrl,
        api_key: input.virtualKey,
        usage_id: 'agent',
      },
      tools: tools.map((name) => ({ name, params: {} })),
      agent_context: {
        load_project_skills: true,
        load_user_skills: false,
        load_public_skills: false,
        load_memory: false,
      },
    },
    workspace: { kind: 'LocalWorkspace', working_dir: input.workingDir },
    initial_message: {
      role: 'user',
      content: [{ type: 'text', text: buildTaskMessage(contract, input.task, input.workingDir) }],
      run: true,
    },
    max_iterations: contract.max_iterations,
    stuck_detection: true,
    autotitle: false,
    // Trace labels (scalars only): codes and IDs, no client data.
    observability_metadata: {
      run_id: contract.run_id,
      intent_id: contract.intent_id,
      tenant_id: contract.tenant_id,
      agent_id: contract.agent_id,
    },
  };
}
