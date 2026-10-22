// Pure builders for the OpenCode 1.18.35 requests (design/ADR-M68 §4, §6; ADR-M88). Pure, so
// tests can check exactly what reaches the sandbox.
//
// - Model: the provider `litellm` (OpenAI-compatible) at LiteLLM with the run's virtual key, set
//   through `PUT /auth/litellm` (never an environment variable; R061).
// - Global configuration (`PATCH /global/config`, never `PATCH /config`, gap 3): the provider, the
//   run's model as `model` and `small_model`, the iteration cap as the `build` agent's `steps`, and
//   the `title` agent switched off (gap 5: a session title would cost a model call).
// - Tools (gap 9): the platform's three tools map to OpenCode's own; every other tool ID the server
//   lists, also one a new version adds, is off in the prompt.
// - Task message: `buildTaskMessage` of `@sdlc/agent-kit` with OpenCode's last rule.
// - Git commands travel base64-encoded to their own `sh` (gap 4).
import { buildTaskMessage, checkTask, toolsOf } from '@sdlc/agent-kit';
import { AgentError, type AgentTool, type StartAgentRun } from '@sdlc/contracts';

/** The provider ID of LiteLLM in OpenCode's configuration. */
export const PROVIDER = 'litellm';
/** The agent that works on the task (OpenCode's default primary agent). */
export const AGENT = 'build';

/** The last rule of the OpenCode task message: OpenCode has no finish tool (ADR-M68 §4). */
export const FINISH_RULE =
  '- When the task is done, stop and reply with a short summary (no further tool calls).';

/** Platform tool → OpenCode tool IDs (ADR-M68 §4). Every other ID is off. */
export const TOOL_MAP: Readonly<Record<AgentTool, readonly string[]>> = {
  file_editor: [
    'read',
    'edit',
    'write',
    'patch',
    'multiedit',
    'glob',
    'grep',
    'list',
    'apply_patch',
  ],
  terminal: ['bash'],
  task_tracker: ['todowrite', 'todoread'],
};

/** Checks the run before anything reaches the sandbox; returns its tools. */
export function checkStart(input: StartAgentRun): AgentTool[] {
  if (!input.contract.allowed_models.includes(input.model.model)) {
    throw new AgentError('model_not_allowed');
  }
  checkTask(input.contract, input.task);
  return toolsOf(input.contract);
}

/** Body of `PATCH /global/config`. */
export function globalConfig(input: StartAgentRun): Record<string, unknown> {
  const model = input.model.model;
  return {
    enabled_providers: [PROVIDER],
    provider: {
      [PROVIDER]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'LiteLLM',
        options: { baseURL: `${input.model.baseUrl.replace(/\/$/, '')}/v1` },
        models: { [model]: { name: model, tool_call: true } },
      },
    },
    model: `${PROVIDER}/${model}`,
    small_model: `${PROVIDER}/${model}`,
    agent: {
      [AGENT]: { steps: input.contract.max_iterations },
      title: { disable: true },
    },
  };
}

/** The tool switches of the prompt: on for the run's tools, off for every other ID. */
export function toolSwitches(
  ids: readonly string[],
  tools: readonly AgentTool[],
): Record<string, boolean> {
  const allowed = new Set(tools.flatMap((tool) => TOOL_MAP[tool]));
  return Object.fromEntries(ids.map((id) => [id, allowed.has(id)]));
}

/** Body of `POST /session/:id/prompt_async`. */
export function promptBody(
  input: StartAgentRun,
  switches: Readonly<Record<string, boolean>>,
): Record<string, unknown> {
  const text = buildTaskMessage(input.contract, input.task, input.workingDir, {
    finishRule: FINISH_RULE,
  });
  return {
    model: { providerID: PROVIDER, modelID: input.model.model },
    agent: AGENT,
    tools: switches,
    parts: [{ type: 'text', text }],
  };
}

/** The marker of the exit code at the end of a wrapped script's output. */
export const EXIT_MARKER = 'sdlc:exit:';
const EXIT_LINE = /(?:^|\n)sdlc:exit:(\d{1,3})\s*$/;

/**
 * OpenCode's shell endpoint evaluates the command once more, so `$…` and quotes would expand too
 * early (ADR-M68 §6 gap 4). The script travels base64-encoded and runs in its own `sh`, in a
 * subshell so that its `exit` still leaves the exit code as the last line of the output.
 */
export function wrapped(script: string): string {
  const payload = `(\n${script}\n)\necho "${EXIT_MARKER}$?"\n`;
  const encoded = Buffer.from(payload, 'utf8').toString('base64');
  return `echo ${encoded} | base64 -d | sh`;
}

/** The exit code of a wrapped script; undefined when the marker is missing (fails closed). */
export function exitCodeOf(output: string): number | undefined {
  const match = EXIT_LINE.exec(output);
  return match ? Number(match[1]) : undefined;
}
