// Scripted replies for the stub model (C01 spike). Pure logic, so it can be unit-tested.
// The stub lets the PoC prove the whole wiring (Agent Server → LiteLLM → model) without a provider key.
//
// The script is chosen by a marker in the first user message:
//   [poc:edit]  create one file with file_editor, then finish (default)
//   [poc:loop]  run the same terminal command forever (loop detection test)
//   [poc:slow]  like edit, but every reply waits SLOW_REPLY_MS (interrupt / kill test)

export type Script = 'edit' | 'loop' | 'slow';

export const POC_FILE_NAME = 'poc-hello.txt';
export const POC_FILE_TEXT = 'Hello from the C01 stub model.\n';
export const LOOP_COMMAND = 'ls';
export const SLOW_REPLY_MS = 20_000;

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
}

export interface ChatTool {
  type: 'function';
  function: { name: string; parameters?: JsonSchema };
}

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ScriptedReply {
  content: string | null;
  toolCalls: ToolCall[];
  delayMs: number;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      if (part && typeof part === 'object' && 'text' in part) {
        const text: unknown = part.text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join(' ');
}

export function scriptFor(request: ChatRequest): Script {
  const firstUser = request.messages.find((m) => m.role === 'user');
  const text = textOf(firstUser?.content);
  if (text.includes('[poc:loop]')) return 'loop';
  if (text.includes('[poc:slow]')) return 'slow';
  return 'edit';
}

/** A placeholder value that satisfies a JSON schema type, for required fields the script does not set. */
function placeholder(schema: JsonSchema | undefined): unknown {
  if (!schema) return '';
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  const first = schema.anyOf?.find((s) => s.type !== 'null');
  if (first) return placeholder(first);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '';
  }
}

/** Fills every required parameter the script did not set (for example `summary`, `security_risk`). */
export function completeArguments(
  tool: ChatTool | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const params = tool?.function.parameters;
  const filled: Record<string, unknown> = { ...args };
  for (const name of params?.required ?? []) {
    if (!(name in filled)) filled[name] = placeholder(params?.properties?.[name]);
  }
  return filled;
}

function findTool(request: ChatRequest, name: string): ChatTool | undefined {
  return request.tools?.find((t) => t.function.name === name);
}

function call(
  request: ChatRequest,
  step: number,
  name: string,
  args: Record<string, unknown>,
): ToolCall {
  return {
    id: `call_poc_${step}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(completeArguments(findTool(request, name), args)) },
  };
}

/** Working directory of the agent: the PoC task message names it as `Working directory: <path>`. */
export function workingDirOf(request: ChatRequest): string {
  const firstUser = request.messages.find((m) => m.role === 'user');
  const match = /Working directory: (\/[\w./-]+)/.exec(textOf(firstUser?.content));
  if (match?.[1]) return match[1].replace(/[./]+$/, '');
  return '/workspace/project';
}

export function scriptedReply(
  request: ChatRequest,
  workingDir = workingDirOf(request),
): ScriptedReply {
  const script = scriptFor(request);
  const step = request.messages.filter((m) => m.role === 'assistant').length;
  const delayMs = script === 'slow' ? SLOW_REPLY_MS : 0;

  if (script === 'loop') {
    return {
      content: null,
      toolCalls: [call(request, step, 'terminal', { command: LOOP_COMMAND })],
      delayMs,
    };
  }
  if (step === 0) {
    return {
      content: null,
      toolCalls: [
        call(request, step, 'file_editor', {
          command: 'create',
          path: `${workingDir}/${POC_FILE_NAME}`,
          file_text: POC_FILE_TEXT,
        }),
      ],
      delayMs,
    };
  }
  return {
    content: null,
    toolCalls: [call(request, step, 'finish', { message: 'C01 stub: file created.' })],
    delayMs,
  };
}
