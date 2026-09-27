// D-08 C05 AC1, AC4: `OpenHandsAdapter` against a fake Agent Server (ADR-M10 §2.2, ADR-M29).
// Every call carries the per-run session key; answers the adapter does not know fail closed; text
// from the Agent Server never reaches an error.
import { OpenHandsAdapter, toAgentState } from '@sdlc/adapter-agent-openhands';
import { AgentError, type AgentRunHandle } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { CONTRACT, CONVERSATION_ID, SESSION_KEY, TASK, VIRTUAL_KEY, secret } from './helpers';

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Reply = { status: number; body: unknown };

function fakeServer(route: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const reply = route(call);
    return Promise.resolve(
      new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
        status: reply.status,
      }),
    );
  }) as typeof fetch;
  return { calls, adapter: new OpenHandsAdapter({ fetch: fetchFn }) };
}

const endpoint = { baseUrl: 'http://sdlc-sandbox-x:8000', sessionKey: secret(SESSION_KEY) };
const handle: AgentRunHandle = {
  runId: CONTRACT.run_id,
  conversationId: CONVERSATION_ID,
  endpoint,
  workingDir: '/workspace',
};

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentError) {
      expect(error.message).not.toContain('secret server text');
      return error.code;
    }
    return 'other';
  }
  return undefined;
}

describe('OpenHandsAdapter', () => {
  it('starts a conversation with the session key and returns the handle (AC1)', async () => {
    const { calls, adapter } = fakeServer(() => ({ status: 200, body: { id: CONVERSATION_ID } }));
    const started = await adapter.startRun({
      contract: CONTRACT,
      endpoint,
      model: {
        model: 'gpt-oss-20b',
        baseUrl: 'http://litellm:4000',
        virtualKey: secret(VIRTUAL_KEY),
      },
      task: TASK,
      workingDir: '/workspace',
    });
    expect(started).toMatchObject({ conversationId: CONVERSATION_ID, runId: CONTRACT.run_id });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/conversations');
    expect(calls[0]?.headers['X-Session-API-Key']).toBe(SESSION_KEY);
  });

  const logServer = (status: string, events: object[]) =>
    fakeServer(({ url }) =>
      url.pathname.endsWith('/events/search')
        ? { status: 200, body: { items: events, next_page_id: null } }
        : { status: 200, body: { id: CONVERSATION_ID, execution_status: status } },
    );

  it('reads the state and counts steps as ActionEvents in the log (no kind filter)', async () => {
    const { calls, adapter } = logServer('finished', [
      { kind: 'MessageEvent' },
      { kind: 'ActionEvent' },
      { kind: 'ObservationEvent' },
      { kind: 'ActionEvent' },
    ]);
    expect(await adapter.getStatus(handle)).toEqual({ state: 'finished', iterations: 2 });
    // The kind filter matches nothing in Agent Server 1.48.0 (C05 live test): never used.
    expect(calls.some((c) => c.url.searchParams.has('kind'))).toBe(false);
    expect(calls.every((c) => c.headers['X-Session-API-Key'] === SESSION_KEY)).toBe(true);
  });

  it('reports the iteration cap from the MaxIterationsReached error event (AC3)', async () => {
    const { adapter } = logServer('error', [
      { kind: 'ActionEvent' },
      { kind: 'ActionEvent' },
      { kind: 'ActionEvent' },
      { kind: 'ConversationErrorEvent', code: 'MaxIterationsReached' },
    ]);
    expect(await adapter.getStatus(handle)).toEqual({ state: 'max_iterations', iterations: 3 });
  });

  it('keeps an error an error when no iteration cap was reached', async () => {
    const { adapter } = logServer('error', [
      { kind: 'ActionEvent' },
      { kind: 'ConversationErrorEvent', code: 'LLMError' },
    ]);
    expect(await adapter.getStatus(handle)).toEqual({ state: 'error', iterations: 1 });
  });

  it.each([
    ['idle before the first step', 'idle', 0, 'running'],
    ['idle after steps (iteration cap)', 'idle', 5, 'stopped'],
    ['paused after an interrupt', 'paused', 5, 'stopped'],
    ['stuck', 'stuck', 5, 'stuck'],
    ['error', 'error', 5, 'error'],
    ['waiting for a confirmation (never configured)', 'waiting_for_confirmation', 1, 'error'],
  ] as const)('maps %s', (_, status, iterations, state) => {
    expect(toAgentState(status, iterations)).toBe(state);
  });

  it('fails closed on an unknown status, and hides the server text', async () => {
    const { adapter } = fakeServer(() => ({
      status: 200,
      body: { id: CONVERSATION_ID, execution_status: 'secret server text' },
    }));
    expect(await errorCode(adapter.getStatus(handle))).toBe('invalid_response');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [500, 'server_error'],
    [422, 'invalid_response'],
  ])('maps HTTP %i to %s', async (status, expected) => {
    const { adapter } = fakeServer(() => ({ status, body: 'secret server text' }));
    expect(await errorCode(adapter.stop(handle))).toBe(expected);
  });

  it('interrupts to stop', async () => {
    const { calls, adapter } = fakeServer(() => ({ status: 200, body: true }));
    await adapter.stop(handle);
    expect(calls[0]?.url.pathname).toBe(`/api/conversations/${CONVERSATION_ID}/interrupt`);
  });

  it('commits through the bash endpoint and refuses when the agent left the branch (#80)', async () => {
    let stdout = `sdlc:committed\nsdlc:head:${'f'.repeat(40)}\n`;
    let exit = 0;
    const { calls, adapter } = fakeServer(() => ({
      status: 200,
      body: { exit_code: exit, stdout },
    }));
    const input = {
      branch: CONTRACT.branch,
      author: { name: 'sdlc-agent', email: 'agent-x@agents.sdlc.invalid' },
      message: 'sdlc: agent run x',
    };
    expect(await adapter.commitWork(handle, input)).toEqual({
      headSha: 'f'.repeat(40),
      committed: true,
    });
    expect(calls[0]?.url.pathname).toBe('/api/bash/execute_bash_command');
    stdout = 'sdlc:branch_changed\n';
    exit = 3;
    expect(await errorCode(adapter.commitWork(handle, input))).toBe('branch_changed');
    stdout = 'no markers';
    exit = 0;
    expect(await errorCode(adapter.commitWork(handle, input))).toBe('git_failed');
  });

  it('collects changed files, the last commit and every page of the log (AC4)', async () => {
    const sha = 'f'.repeat(40);
    const { adapter } = fakeServer(({ url }) => {
      if (url.pathname === '/api/bash/execute_bash_command') {
        return {
          status: 200,
          body: {
            exit_code: 0,
            stdout: `sdlc:head:${sha}\nsdlc:changes\nA\thello.txt\nM\tREADME.md\nsdlc:end\n`,
          },
        };
      }
      const page = url.searchParams.get('page_id');
      return page
        ? { status: 200, body: { items: [{ kind: 'ActionEvent' }], next_page_id: null } }
        : {
            status: 200,
            body: {
              items: [{ kind: 'MessageEvent' }, { kind: 'ActionEvent' }],
              next_page_id: 'p2',
            },
          };
    });
    const outputs = await adapter.collectOutputs(handle, CONTRACT.base_sha);
    expect(outputs.headSha).toBe(sha);
    expect(outputs.changedFiles).toEqual([
      { path: 'hello.txt', status: 'added' },
      { path: 'README.md', status: 'modified' },
    ]);
    expect(outputs.events).toHaveLength(3);
    expect(outputs.iterations).toBe(2);
  });

  it('stops reading an answer above the size limit, as a stream (bounded memory)', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const fetchFn = (() => Promise.resolve(new Response(endless, { status: 200 }))) as typeof fetch;
    const adapter = new OpenHandsAdapter({ fetch: fetchFn });
    expect(await errorCode(adapter.getStatus(handle))).toBe('invalid_response');
    // 16 MiB limit, 64 KiB chunks: it stopped right after the limit.
    expect(pulled).toBeLessThan(16 * 16 + 5);
  });

  it('refuses a base URL with credentials and a short session key', () => {
    const bad = new OpenHandsAdapter();
    const withUser = { ...handle, endpoint: { ...endpoint, baseUrl: 'http://u:p@x:8000' } };
    const shortKey = { ...handle, endpoint: { ...endpoint, sessionKey: secret('short') } };
    return Promise.all([
      errorCode(bad.stop(withUser)).then((c) => expect(c).toBe('invalid_input')),
      errorCode(bad.stop(shortKey)).then((c) => expect(c).toBe('invalid_input')),
    ]);
  });
});
