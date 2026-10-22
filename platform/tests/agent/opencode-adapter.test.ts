// X03 AC1 (ADR-M68 §4, §6; ADR-M88): `OpenCodeAdapter` against a fake OpenCode server. Every call
// carries the server password; the key goes only to `PUT /auth`; `PATCH /config` is never called;
// the adapter enforces the cap and fails the run when the agent changes its own configuration or
// tools (gap 1); answers it does not know fail closed; server text never reaches an error.
import { OpenCodeAdapter } from '@sdlc/adapter-agent-opencode';
import { commitCommand, diffCommand } from '@sdlc/agent-kit';
import { AgentError, type AgentRunHandle, type StartAgentRun } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { CONTRACT, SESSION_KEY, TASK, VIRTUAL_KEY, secret } from './helpers';

const SESSION_ID = 'ses_0123456789abcdefABCDEF';
const BASIC = `Basic ${Buffer.from(`opencode:${SESSION_KEY}`).toString('base64')}`;
const IDS = ['bash', 'read', 'edit', 'write', 'glob', 'grep', 'list', 'webfetch', 'task'];

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Reply = { status: number; body: unknown };

/** A fake `opencode serve` with the state the adapter reads. Tests change the state directly. */
function fakeServer() {
  const state = {
    global: {} as Record<string, unknown>,
    /** What a repository's `opencode.json` adds on top (it ranks above the global file). */
    repo: {} as Record<string, unknown>,
    sessions: [] as string[],
    ids: [...IDS],
    session: 'busy' as string,
    messages: [] as unknown[],
    shellOutput: 'sdlc:exit:0\n',
    override: undefined as ((call: Call) => Reply | undefined) | undefined,
  };
  const calls: Call[] = [];
  const route = (call: Call): Reply => {
    const custom = state.override?.(call);
    if (custom) return custom;
    const key = `${call.method} ${call.path}`;
    if (key === 'PUT /auth/litellm') return { status: 200, body: true };
    if (key === 'PATCH /global/config') {
      state.global = { ...state.global, ...(call.body as Record<string, unknown>) };
      return { status: 200, body: state.global };
    }
    if (key === 'GET /global/config') return { status: 200, body: state.global };
    if (key === 'GET /config') {
      const image = {
        share: 'disabled',
        mcp: {},
        permission: { webfetch: 'deny', doom_loop: 'deny' },
      };
      return { status: 200, body: { ...state.global, ...image, ...state.repo } };
    }
    if (key === 'GET /session') return { status: 200, body: state.sessions.map((id) => ({ id })) };
    if (key === 'POST /instance/dispose') return { status: 200, body: true };
    if (key === 'GET /experimental/tool/ids') return { status: 200, body: state.ids };
    if (key === 'POST /session') {
      state.sessions.push(SESSION_ID);
      return { status: 200, body: { id: SESSION_ID } };
    }
    if (key === `POST /session/${SESSION_ID}/prompt_async`) return { status: 204, body: '' };
    if (key === 'GET /session/status') {
      return {
        status: 200,
        body: state.session === 'idle' ? {} : { [SESSION_ID]: { type: state.session } },
      };
    }
    if (key === `GET /session/${SESSION_ID}/message`) return { status: 200, body: state.messages };
    if (key === `POST /session/${SESSION_ID}/abort`) {
      state.session = 'idle';
      return { status: 200, body: true };
    }
    if (key === `POST /session/${SESSION_ID}/shell`) {
      return {
        status: 200,
        body: {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'tool',
              tool: 'bash',
              state: { status: 'completed', output: state.shellOutput },
            },
          ],
        },
      };
    }
    return { status: 404, body: 'secret server text' };
  };
  const fetchFn = ((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const reply = route(call);
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(reply.status === 204 ? null : text, { status: reply.status }),
    );
  }) as typeof fetch;
  return { state, calls, fetchFn, adapter: new OpenCodeAdapter({ fetch: fetchFn }) };
}

const INPUT: StartAgentRun = {
  contract: { ...CONTRACT, agent_adapter: 'opencode', max_iterations: 3 },
  endpoint: { baseUrl: 'http://sdlc-sandbox-x:8000', sessionKey: secret(SESSION_KEY) },
  model: { model: 'stub-model', baseUrl: 'http://litellm:4000', virtualKey: secret(VIRTUAL_KEY) },
  task: TASK,
  workingDir: '/workspace',
};

const user = { info: { role: 'user' }, parts: [{ type: 'text', text: 'task' }] };
const step = (tool = 'read', input: unknown = { filePath: 'a' }, error?: string, output = 'x') => ({
  info: {
    role: 'assistant',
    ...(error ? { error: { name: error, data: { message: 'secret server text' } } } : {}),
  },
  parts: [
    { type: 'step-start' },
    { type: 'tool', tool, state: { status: 'completed', input, output } },
    { type: 'step-finish' },
  ],
});

async function errorOf(promise: Promise<unknown>): Promise<AgentError | undefined> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentError);
    expect(String((error as Error).message)).not.toContain('secret server text');
    expect(JSON.stringify(error)).not.toContain(VIRTUAL_KEY);
    return error as AgentError;
  }
  return undefined;
}

async function started() {
  const server = fakeServer();
  const handle = await server.adapter.startRun(INPUT);
  return { ...server, handle };
}

describe('OpenCodeAdapter.startRun', () => {
  it('sets the key, the global configuration, a new instance, then prompts with the switches', async () => {
    const { calls, handle } = await started();
    expect(handle).toEqual({
      runId: CONTRACT.run_id,
      conversationId: SESSION_ID,
      endpoint: INPUT.endpoint,
      workingDir: '/workspace',
    });
    const order = calls.map((c) => `${c.method} ${c.path}`);
    expect(order.slice(0, 4)).toEqual([
      'PUT /auth/litellm',
      'PATCH /global/config',
      'POST /instance/dispose',
      'GET /config',
    ]);
    expect(order.at(-1)).toBe(`POST /session/${SESSION_ID}/prompt_async`);
    // The baseline fingerprint covers the run's own session, read after it was created.
    expect(order.lastIndexOf('GET /session')).toBeGreaterThan(order.indexOf('POST /session'));
    const prompt = calls.at(-1)!.body as { tools: Record<string, boolean> };
    expect(
      Object.entries(prompt.tools)
        .filter(([, on]) => on)
        .map(([id]) => id)
        .sort(),
    ).toEqual(['bash', 'edit', 'glob', 'grep', 'list', 'read', 'write']);
    expect(prompt.tools.webfetch).toBe(false);
  });

  it('every call sends the server password; the key goes to PUT /auth only; never PATCH /config (gap 3)', async () => {
    const { calls } = await started();
    for (const call of calls) expect(call.headers.authorization).toBe(BASIC);
    const withKey = calls.filter((c) => JSON.stringify(c.body ?? '').includes(VIRTUAL_KEY));
    expect(withKey.map((c) => c.path)).toEqual(['/auth/litellm']);
    expect(withKey[0]!.body).toEqual({ type: 'api', key: VIRTUAL_KEY });
    expect(calls.some((c) => c.method === 'PATCH' && c.path === '/config')).toBe(false);
  });

  it('refuses a model outside allowed_models or a tool the platform never grants, before any call', async () => {
    const server = fakeServer();
    const model = await errorOf(
      server.adapter.startRun({ ...INPUT, model: { ...INPUT.model, model: 'other' } }),
    );
    expect(model?.code).toBe('model_not_allowed');
    const tool = await errorOf(
      server.adapter.startRun({
        ...INPUT,
        contract: { ...INPUT.contract, allowed_tools: ['browser_tool_set'] },
      }),
    );
    expect(tool?.code).toBe('tool_not_allowed');
    expect(server.calls).toEqual([]);
  });

  it('refuses to start when a repository opencode.json changes what the run needs', async () => {
    const server = fakeServer();
    server.state.repo = { agent: { build: { steps: 999 } } };
    const error = await errorOf(server.adapter.startRun(INPUT));
    expect(error?.code).toBe('config_changed');
    expect(error?.params).toEqual({ field: 'steps' });
    expect(server.calls.some((c) => c.path.endsWith('/prompt_async'))).toBe(false);
  });

  it('refuses a session ID it does not know, and a short session key', async () => {
    const server = fakeServer();
    server.state.override = (c) =>
      c.method === 'POST' && c.path === '/session'
        ? { status: 200, body: { id: '../x' } }
        : undefined;
    expect((await errorOf(server.adapter.startRun(INPUT)))?.code).toBe('invalid_response');
    const short = { ...INPUT, endpoint: { ...INPUT.endpoint, sessionKey: secret('short') } };
    expect((await errorOf(fakeServer().adapter.startRun(short)))?.code).toBe('invalid_input');
  });

  it('maps HTTP errors to codes, never to server text', async () => {
    const server = fakeServer();
    server.state.override = () => ({ status: 401, body: 'secret server text' });
    expect((await errorOf(server.adapter.startRun(INPUT)))?.code).toBe('unauthorized');
    server.state.override = () => ({ status: 500, body: 'secret server text' });
    expect((await errorOf(server.adapter.startRun(INPUT)))?.code).toBe('server_error');
  });
});

describe('OpenCodeAdapter.getStatus', () => {
  it('running while busy; finished when idle without error under the cap', async () => {
    const { state, adapter, handle } = await started();
    state.messages = [user, step()];
    expect(await adapter.getStatus(handle)).toEqual({
      state: 'running',
      iterations: 1,
      events: 4,
      identicalCalls: 1,
    });
    state.session = 'idle';
    expect((await adapter.getStatus(handle)).state).toBe('finished');
  });

  it('stops the run itself at the cap, whatever OpenCode does (gap 1); max_iterations once idle', async () => {
    const { state, calls, adapter, handle } = await started();
    const ls = () => step('bash', { command: 'ls' });
    state.messages = [user, ls(), ls(), ls()];
    // At the cap and still busy: abort, wait for the session to go idle, then the cap.
    expect(await adapter.getStatus(handle)).toMatchObject({
      state: 'max_iterations',
      iterations: 3,
      identicalCalls: 3,
    });
    expect(calls.filter((c) => c.path.endsWith('/abort'))).toHaveLength(1);
    state.messages = [user, ls(), ls(), step('bash', { command: 'ls' }, 'MessageAbortedError')];
    expect((await adapter.getStatus(handle)).state).toBe('max_iterations');
  });

  it('at the cap: running while the abort has not settled; an abort that fails is tried again', async () => {
    const server = fakeServer();
    const adapter = new OpenCodeAdapter({ fetch: server.fetchFn, capSettleMs: 0 });
    const handle = await adapter.startRun(INPUT);
    server.state.messages = [user, step(), step(), step()];
    server.state.override = (c) =>
      c.path.endsWith('/abort') ? { status: 500, body: 'x' } : undefined;
    expect((await errorOf(adapter.getStatus(handle)))?.code).toBe('server_error');
    // The abort is accepted but the session stays busy for a while.
    server.state.override = (c) =>
      c.path.endsWith('/abort') ? { status: 200, body: true } : undefined;
    expect((await adapter.getStatus(handle)).state).toBe('running');
    server.state.override = undefined;
    expect((await adapter.getStatus(handle)).state).toBe('max_iterations');
    expect(server.calls.filter((c) => c.path.endsWith('/abort'))).toHaveLength(3);
  });

  it('a run that finishes on its last allowed step is finished, not stopped', async () => {
    const { state, adapter, handle } = await started();
    state.session = 'idle';
    state.messages = [user, step(), step(), step()];
    expect((await adapter.getStatus(handle)).state).toBe('finished');
  });

  it('the counts never go down: deleting messages through the server does not undo steps', async () => {
    const { state, adapter, handle } = await started();
    state.messages = [user, step(), step()];
    expect(await adapter.getStatus(handle)).toMatchObject({ iterations: 2, events: 7 });
    state.messages = [user];
    expect(await adapter.getStatus(handle)).toMatchObject({ iterations: 2, events: 7 });
    state.messages = [user, step()];
    expect(await adapter.getStatus(handle)).toMatchObject({ state: 'running', iterations: 2 });
  });

  it('stopped after an abort; error after any other error', async () => {
    const { state, adapter, handle } = await started();
    state.session = 'idle';
    state.messages = [user, step('read', {}, 'MessageAbortedError')];
    expect((await adapter.getStatus(handle)).state).toBe('stopped');
    state.messages = [user, step('read', {}, 'ProviderAuthError')];
    expect((await adapter.getStatus(handle)).state).toBe('error');
  });

  it('a change of the global configuration aborts the run and fails it with config_changed', async () => {
    const { state, calls, adapter, handle } = await started();
    state.messages = [user, step()];
    state.global = { ...state.global, agent: { build: { steps: 999 } } };
    expect((await errorOf(adapter.getStatus(handle)))?.code).toBe('config_changed');
    expect(calls.filter((c) => c.path.endsWith('/abort'))).toHaveLength(1);
    // Sticky: also when the agent puts the configuration back.
    state.global = { ...state.global, agent: { build: { steps: 3 }, title: { disable: true } } };
    expect((await errorOf(adapter.getStatus(handle)))?.code).toBe('config_changed');
  });

  it('a session the agent starts through its server fails the run with config_changed', async () => {
    const { state, adapter, handle } = await started();
    state.sessions.push('ses_agentOwnSession');
    expect((await errorOf(adapter.getStatus(handle)))?.code).toBe('config_changed');
  });

  it('a new tool ID (an MCP server the agent added) fails the run with config_changed', async () => {
    const { state, adapter, handle } = await started();
    state.ids = [...IDS, 'mcp_evil_tool'];
    expect((await errorOf(adapter.getStatus(handle)))?.code).toBe('config_changed');
  });

  it('a run this adapter did not start fails closed', async () => {
    const { adapter } = fakeServer();
    const other: AgentRunHandle = {
      runId: '99999999-9999-4999-8999-999999999999',
      conversationId: SESSION_ID,
      endpoint: INPUT.endpoint,
      workingDir: '/workspace',
    };
    expect((await errorOf(adapter.getStatus(other)))?.code).toBe('invalid_input');
  });

  it('a session status or message it does not know fails closed', async () => {
    const { state, adapter, handle } = await started();
    state.override = (c) =>
      c.path === '/session/status'
        ? { status: 200, body: { [SESSION_ID]: { type: 'sleeping' } } }
        : undefined;
    expect((await errorOf(adapter.getStatus(handle)))?.code).toBe('invalid_response');
    state.override = undefined;
    state.messages = [{ info: {}, parts: [] }];
    expect((await errorOf(adapter.getStatus(handle)))?.code).toBe('invalid_response');
  });
});

describe('OpenCodeAdapter.stop, commitWork, collectOutputs', () => {
  const decode = (command: string) => {
    const match = /^echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh$/.exec(command);
    expect(match).not.toBeNull();
    return Buffer.from(match![1]!, 'base64').toString('utf8');
  };
  const commit = {
    branch: CONTRACT.branch,
    author: { name: 'sdlc-agent', email: 'agent@sdlc.invalid' },
    message: 'agent: INT-2026-0001',
  };

  it('stop aborts the session', async () => {
    const { calls, adapter, handle } = await started();
    await adapter.stop(handle);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/session/${SESSION_ID}/abort` });
  });

  it('commitWork sends the agent-kit commit command, wrapped, to the build agent shell', async () => {
    const { state, calls, adapter, handle } = await started();
    const head = 'f'.repeat(40);
    state.shellOutput = `sdlc:committed\nsdlc:head:${head}\nsdlc:exit:0\n`;
    expect(await adapter.commitWork(handle, commit)).toEqual({ headSha: head, committed: true });
    const body = calls.at(-1)!.body as { agent: string; command: string };
    expect(body.agent).toBe('build');
    expect(decode(body.command)).toContain(commitCommand({ workingDir: '/workspace', ...commit }));
  });

  it('commitWork: branch_changed, a failed command or a missing marker', async () => {
    const { state, adapter, handle } = await started();
    state.shellOutput = 'sdlc:branch_changed\nsdlc:exit:3\n';
    expect((await errorOf(adapter.commitWork(handle, commit)))?.code).toBe('branch_changed');
    state.shellOutput = 'sdlc:exit:5\n';
    const failed = await errorOf(adapter.commitWork(handle, commit));
    expect(failed?.code).toBe('git_failed');
    expect(failed?.params).toEqual({ exit_code: 5 });
    state.shellOutput = `sdlc:head:${'f'.repeat(40)}\n`;
    expect((await errorOf(adapter.commitWork(handle, commit)))?.code).toBe('git_failed');
  });

  it('collectOutputs: the changed files, the head, the steps and the log with roles', async () => {
    const { state, calls, adapter, handle } = await started();
    const head = 'f'.repeat(40);
    state.shellOutput = `sdlc:head:${head}\nsdlc:changes\nA\thello.txt\nM\t"a\\tb.md"\nsdlc:end\nsdlc:exit:0\n`;
    state.messages = [user, step()];
    const outputs = await adapter.collectOutputs(handle, CONTRACT.base_sha);
    expect(outputs.changedFiles).toEqual([
      { path: 'hello.txt', status: 'added' },
      { path: 'a\tb.md', status: 'modified' },
    ]);
    expect(outputs.headSha).toBe(head);
    expect(outputs.iterations).toBe(1);
    expect(outputs.events[0]).toMatchObject({ role: 'user', type: 'text' });
    // The session key is the server password: an agent that prints it never puts it in evidence.
    state.messages = [
      user,
      step('bash', { command: 'env' }, undefined, `OPENCODE_SERVER_PASSWORD=${SESSION_KEY}`),
    ];
    const printed = await adapter.collectOutputs(handle, CONTRACT.base_sha);
    expect(JSON.stringify(printed.events)).not.toContain(SESSION_KEY);
    expect(JSON.stringify(printed.events)).toContain('OPENCODE_SERVER_PASSWORD=[redacted]');
    expect(outputs.events).toHaveLength(4);
    const shell = calls.find((c) => c.path.endsWith('/shell'))!.body as { command: string };
    expect(decode(shell.command)).toContain(diffCommand('/workspace', CONTRACT.base_sha));
    state.shellOutput = 'sdlc:no_base\nsdlc:exit:3\n';
    expect((await errorOf(adapter.collectOutputs(handle, CONTRACT.base_sha)))?.code).toBe(
      'git_failed',
    );
  });
});
