import { describe, expect, it } from 'vitest';

import {
  completeArguments,
  LOOP_COMMAND,
  POC_FILE_NAME,
  scriptedReply,
  scriptFor,
  SLOW_REPLY_MS,
  workingDirOf,
  type ChatRequest,
  type ChatTool,
} from '../src/stub-script.ts';

const tools: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'file_editor',
      parameters: {
        required: ['command', 'path', 'summary', 'security_risk'],
        properties: { security_risk: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] } },
      },
    },
  },
  { type: 'function', function: { name: 'finish', parameters: { required: ['message'] } } },
  { type: 'function', function: { name: 'terminal', parameters: { required: ['command'] } } },
];

function request(text: string, assistantTurns = 0): ChatRequest {
  const messages = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: [{ type: 'text', text }] },
  ];
  for (let i = 0; i < assistantTurns; i += 1) {
    messages.push({ role: 'assistant', content: '' }, { role: 'tool', content: 'ok' });
  }
  return { model: 'poc-stub', messages, tools };
}

const args = (reply: ReturnType<typeof scriptedReply>) =>
  JSON.parse(reply.toolCalls[0]?.function.arguments ?? '{}') as Record<string, unknown>;

describe('stub model script', () => {
  it('picks the script from the marker in the first user message', () => {
    expect(scriptFor(request('[poc:loop] go'))).toBe('loop');
    expect(scriptFor(request('[poc:slow] go'))).toBe('slow');
    expect(scriptFor(request('anything else'))).toBe('edit');
  });

  it('edit: creates the file in the named working directory, then finishes', () => {
    const task = 'do it\nWorking directory: /workspace/project';
    const first = scriptedReply(request(task));
    expect(first.toolCalls[0]?.function.name).toBe('file_editor');
    expect(args(first)).toMatchObject({
      command: 'create',
      path: `/workspace/project/${POC_FILE_NAME}`,
    });
    const second = scriptedReply(request(task, 1));
    expect(second.toolCalls[0]?.function.name).toBe('finish');
    expect(first.delayMs).toBe(0);
  });

  it('fills required parameters the script does not set', () => {
    const first = scriptedReply(request('go'));
    expect(args(first)).toMatchObject({ summary: '', security_risk: 'LOW' });
    expect(completeArguments(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  it('loop: repeats the same terminal call on every turn', () => {
    const replies = [0, 1, 2, 3].map((n) => scriptedReply(request('[poc:loop]', n)));
    for (const reply of replies) {
      expect(reply.toolCalls[0]?.function.name).toBe('terminal');
      expect(args(reply)).toEqual({ command: LOOP_COMMAND });
    }
  });

  it('slow: delays every reply', () => {
    expect(scriptedReply(request('[poc:slow]')).delayMs).toBe(SLOW_REPLY_MS);
  });

  it('falls back to /workspace/project when the task names no working directory', () => {
    expect(workingDirOf(request('no directory here'))).toBe('/workspace/project');
    expect(workingDirOf(request('Working directory: /workspace/other.'))).toBe('/workspace/other');
  });
});
