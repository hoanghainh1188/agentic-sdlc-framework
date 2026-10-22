// X03 AC1 (ADR-M68 §4, §6): the pure parts of the OpenCode adapter. What reaches the sandbox: the
// global configuration (gap 3, gap 5), the tool switches (gap 9), the git commands (gap 4) and the
// status mapping (gaps 1 and 10).
import { execFileSync } from 'node:child_process';

import {
  countsOf,
  exitCodeOf,
  globalConfig,
  promptBody,
  stateOf,
  toolSwitches,
  wrapped,
  type OpenCodeMessage,
} from '@sdlc/adapter-agent-opencode';
import { toolCallKey } from '@sdlc/adapter-agent-openhands';
import { callKey } from '@sdlc/agent-kit';
import type { StartAgentRun } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { CONTRACT, SESSION_KEY, TASK, VIRTUAL_KEY, secret } from './helpers';

const INPUT: StartAgentRun = {
  contract: { ...CONTRACT, agent_adapter: 'opencode', max_iterations: 7 },
  endpoint: { baseUrl: 'http://sdlc-sandbox-x:8000', sessionKey: secret(SESSION_KEY) },
  model: { model: 'stub-model', baseUrl: 'http://litellm:4000/', virtualKey: secret(VIRTUAL_KEY) },
  task: TASK,
  workingDir: '/workspace',
};

const IDS = [
  'bash',
  'read',
  'edit',
  'write',
  'glob',
  'grep',
  'list',
  'todowrite',
  'webfetch',
  'task',
  'skill',
  'new_tool_v2',
];

describe('globalConfig', () => {
  const config = globalConfig(INPUT);

  it('points the provider at LiteLLM with the run model, never with the key', () => {
    expect(config).toMatchObject({
      enabled_providers: ['litellm'],
      model: 'litellm/stub-model',
      small_model: 'litellm/stub-model',
      provider: { litellm: { options: { baseURL: 'http://litellm:4000/v1' } } },
    });
    expect(JSON.stringify(config)).not.toContain(VIRTUAL_KEY);
  });

  it('sets the cap as the build agent steps and switches the title agent off (gap 5)', () => {
    expect(config.agent).toEqual({ build: { steps: 7 }, title: { disable: true } });
  });
});

describe('toolSwitches (gap 9)', () => {
  it('turns on only the OpenCode tools of the run, every other ID off', () => {
    const switches = toolSwitches(IDS, ['file_editor']);
    expect(Object.keys(switches)).toEqual(IDS);
    expect(
      Object.entries(switches)
        .filter(([, on]) => on)
        .map(([id]) => id),
    ).toEqual(['read', 'edit', 'write', 'glob', 'grep', 'list']);
  });

  it('terminal is bash only; an unknown ID of a new version stays off', () => {
    const switches = toolSwitches(IDS, ['file_editor', 'terminal', 'task_tracker']);
    expect(switches.bash).toBe(true);
    expect(switches.todowrite).toBe(true);
    for (const id of ['webfetch', 'task', 'skill', 'new_tool_v2']) expect(switches[id]).toBe(false);
  });
});

describe('promptBody', () => {
  it('sends the model, the build agent, the switches and the task message with its last rule', () => {
    const body = promptBody(INPUT, { bash: true });
    expect(body).toMatchObject({
      model: { providerID: 'litellm', modelID: 'stub-model' },
      agent: 'build',
      tools: { bash: true },
    });
    const text = (body.parts as { text: string }[])[0]!.text;
    expect(text).toContain(TASK.spec.path);
    expect(text.split('\n').at(-1)).toContain('reply with a short summary');
    expect(JSON.stringify(body)).not.toContain(VIRTUAL_KEY);
  });
});

describe('wrapped (gap 4)', () => {
  // OpenCode's shell endpoint evaluates the command once more: `eval` stands in for it here.
  const run = (command: string) =>
    execFileSync('sh', ['-c', 'eval "$1"', 'sh', command], { encoding: 'utf8' });

  it('keeps $, quotes and new lines of the script as they are', () => {
    const script = [
      `x='a "b" $HOME'`,
      'printf "%s\\n" "$x"',
      "echo 'line two'",
      'echo "$((1+2))"',
    ].join('\n');
    const out = run(wrapped(script));
    expect(out).toBe(`a "b" $HOME\nline two\n3\nsdlc:exit:0\n`);
    // Only base64 characters reach the second evaluation.
    expect(wrapped(script)).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
  });

  it('reports the exit code of a script that exits early', () => {
    const out = run(wrapped('echo before\nexit 3\necho after'));
    expect(out).toBe('before\nsdlc:exit:3\n');
    expect(exitCodeOf(out)).toBe(3);
  });

  it('a missing marker fails closed', () => {
    expect(exitCodeOf('sdlc:head:abc\n')).toBeUndefined();
    expect(exitCodeOf('sdlc:exit:0\nmore')).toBeUndefined();
  });
});

const user: OpenCodeMessage = { info: { role: 'user' }, parts: [{ type: 'text' }] };
function reply(tools: { tool: string; input: unknown }[], error?: string): OpenCodeMessage {
  return {
    info: { role: 'assistant', ...(error ? { error: { name: error } } : {}) },
    parts: [
      { type: 'step-start' },
      ...tools.map((t) => ({
        type: 'tool',
        tool: t.tool,
        state: { status: 'completed', input: t.input },
      })),
      { type: 'step-finish' },
    ],
  };
}

describe('countsOf (gap 10)', () => {
  it('one iteration per step-finish part; events = every part', () => {
    const counts = countsOf([user, reply([{ tool: 'read', input: { filePath: 'a' } }]), reply([])]);
    expect(counts).toEqual({ iterations: 2, events: 6, identicalCalls: 1 });
  });

  it('identical calls compare the tool and the canonical arguments (same key as OpenHands)', () => {
    const same = { tool: 'bash', input: { command: 'ls', description: 'x' } };
    const reordered = { tool: 'bash', input: { description: 'x', command: 'ls' } };
    const counts = countsOf([user, reply([same]), reply([reordered]), reply([same])]);
    expect(counts.identicalCalls).toBe(3);
    const other = countsOf([
      user,
      reply([same]),
      reply([{ tool: 'bash', input: { command: 'pwd' } }]),
    ]);
    expect(other.identicalCalls).toBe(1);
    expect(callKey('bash', same.input)).toBe(
      toolCallKey({
        kind: 'ActionEvent',
        tool_name: 'bash',
        tool_call: { arguments: JSON.stringify(reordered.input) },
      }),
    );
  });
});

describe('stateOf', () => {
  const base = { cap: 3, stoppedAtCap: false };
  const done = [user, reply([])];

  it('running while busy or retrying, or idle before the first reply', () => {
    expect(stateOf({ ...base, session: 'busy', messages: done, iterations: 1 })).toBe('running');
    expect(stateOf({ ...base, session: 'retry', messages: done, iterations: 1 })).toBe('running');
    expect(stateOf({ ...base, session: 'idle', messages: [user], iterations: 0 })).toBe('running');
  });

  it('finished when idle with no error under the cap; max_iterations at the cap', () => {
    expect(stateOf({ ...base, session: 'idle', messages: done, iterations: 1 })).toBe('finished');
    expect(stateOf({ ...base, session: 'idle', messages: done, iterations: 3 })).toBe(
      'max_iterations',
    );
  });

  it('stopped after an abort, error after any other error, max_iterations after the adapter stopped it', () => {
    const aborted = [user, reply([], 'MessageAbortedError')];
    expect(stateOf({ ...base, session: 'idle', messages: aborted, iterations: 1 })).toBe('stopped');
    const failed = [user, reply([], 'APIError')];
    expect(stateOf({ ...base, session: 'idle', messages: failed, iterations: 1 })).toBe('error');
    expect(
      stateOf({ ...base, stoppedAtCap: true, session: 'idle', messages: aborted, iterations: 3 }),
    ).toBe('max_iterations');
  });
});
