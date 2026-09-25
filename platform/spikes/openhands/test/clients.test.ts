// AC1 / AC2 without Docker: what the spike sends to the Agent Server and to LiteLLM.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentServerClient,
  AgentServerError,
  buildStartConversationBody,
  POC_TOOLS,
  SESSION_HEADER,
} from '../src/agent-server-client.ts';
import { buildKeyRequest, COST_LABEL_NAMES, LiteLlmAdmin } from '../src/litellm-admin.ts';
import { pocLabels } from '../src/poc-run.ts';

const VIRTUAL_KEY = 'sk-virtual-run-key';

function startBody() {
  return buildStartConversationBody({
    llm: {
      modelAlias: 'poc-stub',
      baseUrl: 'http://litellm:4000',
      virtualKey: VIRTUAL_KEY,
      usageId: 'run-1',
    },
    workingDir: '/workspace/project',
    task: 'Do the task',
    maxIterations: 30,
    labels: { tenant: 't', run_id: 'r' },
    stuckDetection: true,
  });
}

type FetchArgs = [string, RequestInit];

function mockFetch(...bodies: unknown[]) {
  const calls: FetchArgs[] = [];
  const queue = [...bodies];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push([url, init]);
    const next = queue.shift();
    const status = next instanceof Response ? next.status : 200;
    const text = next instanceof Response ? next : new Response(JSON.stringify(next), { status });
    return Promise.resolve(text);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('start conversation body (FR-50: the model goes through LiteLLM)', () => {
  it('points the agent LLM at the LiteLLM proxy with the per-run virtual key', () => {
    const body = startBody();
    expect(body['agent']).toMatchObject({
      kind: 'Agent',
      llm: {
        model: 'litellm_proxy/poc-stub',
        base_url: 'http://litellm:4000',
        api_key: VIRTUAL_KEY,
      },
    });
  });

  it('contains no real provider key and no provider endpoint', () => {
    const text = JSON.stringify(startBody());
    expect(text).not.toMatch(/sk-ant-|api\.anthropic\.com|api\.openai\.com|ANTHROPIC|OPENAI_API/i);
  });

  it('sets the iteration cap (FR-32), the working directory and a fixed tool list', () => {
    const body = startBody();
    expect(body['max_iterations']).toBe(30);
    expect(body['workspace']).toEqual({
      kind: 'LocalWorkspace',
      working_dir: '/workspace/project',
    });
    expect(body['autotitle']).toBe(false);
    const agent = body['agent'] as { tools: { name: string }[] };
    expect(agent.tools.map((t) => t.name)).toEqual([...POC_TOOLS]);
    expect(body['initial_message']).toMatchObject({ run: true });
  });
});

describe('AgentServerClient (AC1)', () => {
  it('sends the session key header on every call', async () => {
    const calls = mockFetch({ id: 'c1', execution_status: 'running' });
    const client = new AgentServerClient('http://127.0.0.1:1', 'session-secret');
    const summary = await client.getConversation('c1');
    expect(summary.executionStatus).toBe('running');
    const [url, init] = calls[0]!;
    expect(url).toBe('http://127.0.0.1:1/api/conversations/c1');
    expect((init.headers as Record<string, string>)[SESSION_HEADER]).toBe('session-secret');
  });

  it('follows next_page_id when reading the event log', async () => {
    const calls = mockFetch(
      { items: [{ kind: 'A' }], next_page_id: 'p2' },
      { items: [{ kind: 'B' }], next_page_id: null },
    );
    const client = new AgentServerClient('http://h', 'k');
    const events = await client.listEvents('c1');
    expect(events.map((e) => e.kind)).toEqual(['A', 'B']);
    expect(calls[1]![0]).toContain('page_id=p2');
  });

  it('uses interrupt for an instant stop and reads git changes by path', async () => {
    const calls = mockFetch({ success: true }, [{ path: 'a.txt', status: 'ADDED' }]);
    const client = new AgentServerClient('http://h', 'k');
    await client.interrupt('c1');
    const changes = await client.gitChanges('/workspace/project');
    expect(calls[0]![0]).toBe('http://h/api/conversations/c1/interrupt');
    expect(calls[0]![1].method).toBe('POST');
    expect(calls[1]![0]).toBe('http://h/api/git/changes?path=%2Fworkspace%2Fproject');
    expect(changes).toEqual([{ path: 'a.txt', status: 'ADDED' }]);
  });

  it('raises a clear error on HTTP errors and on unknown states', async () => {
    mockFetch(new Response('nope', { status: 401 }), { id: 'c1', execution_status: 'weird' });
    const client = new AgentServerClient('http://h', 'k');
    await expect(client.getConversation('c1')).rejects.toBeInstanceOf(AgentServerError);
    await expect(client.getConversation('c1')).rejects.toThrow(/execution_status/);
  });
});

describe('LiteLLM virtual key per run (AC2, D-07 §5)', () => {
  it('carries the seven labels, the model list, the budget and a short lifetime', () => {
    const labels = pocLabels('run-42');
    const body = buildKeyRequest({
      labels,
      models: ['poc-stub'],
      maxBudgetUsd: 2,
      durationMinutes: 30,
    });
    expect(body).toMatchObject({ models: ['poc-stub'], max_budget: 2, duration: '30m' });
    const metadata = body['metadata'] as Record<string, string>;
    expect(Object.keys(metadata).sort()).toEqual([...COST_LABEL_NAMES].sort());
    expect(metadata['run_id']).toBe('run-42');
  });

  it('authenticates admin calls with the master key and deletes keys by value', async () => {
    const calls = mockFetch({ key: VIRTUAL_KEY }, { deleted_keys: [VIRTUAL_KEY] });
    const admin = new LiteLlmAdmin('http://litellm', 'sk-master');
    const key = await admin.createRunKey({
      labels: pocLabels('r'),
      models: ['poc-stub'],
      maxBudgetUsd: 1,
      durationMinutes: 5,
    });
    await admin.deleteKey(key);
    expect((calls[0]![1].headers as Record<string, string>)['authorization']).toBe(
      'Bearer sk-master',
    );
    expect(calls[1]![0]).toBe('http://litellm/key/delete');
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ keys: [VIRTUAL_KEY] });
  });
});
