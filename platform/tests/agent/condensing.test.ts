// D-08 X11 AC2–AC4: context condensing in the OpenHands request, the counts the adapter reports and
// the log it hands over (design/ADR-M29 §2.10, QUESTIONS #551–#554). Pure functions and a fake
// Agent Server, so the exact body is checked.
import {
  buildConversationRequest,
  CONDENSER_USAGE_ID,
  condensingCounts,
  OpenHandsAdapter,
  progressEvents,
  trailingIdenticalCalls,
  withoutSummaries,
} from '@sdlc/adapter-agent-openhands';
import {
  CONDENSING_STATES,
  condensingFor,
  type AgentRunHandle,
  type ProjectConfig,
} from '@sdlc/contracts';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { CONTRACT, CONVERSATION_ID, SESSION_KEY, TASK, VIRTUAL_KEY, secret } from './helpers';

const SUMMARY = 'The agent edited src/secret-client-file.ts and ran the tests.';
const CONDENSING = { maxEvents: 120, keepFirst: 2, contextTokens: 32768 };

const input = {
  contract: CONTRACT,
  model: 'gpt-oss-20b',
  llmBaseUrl: 'http://litellm:4000',
  virtualKey: VIRTUAL_KEY,
  workingDir: '/workspace',
  task: TASK,
};

interface Agent {
  readonly llm: Record<string, unknown>;
  readonly condenser?: Record<string, unknown>;
}

const agentOf = (body: Record<string, unknown>) => body.agent as Agent;

describe('the conversation request with condensing (AC3)', () => {
  it('has no condenser and no context size without condensing (the body before X11)', () => {
    const agent = agentOf(buildConversationRequest(input));
    expect(agent).not.toHaveProperty('condenser');
    expect(agent.llm).not.toHaveProperty('max_input_tokens');
  });

  it("summarizes with the run's own model, LiteLLM URL and virtual key", () => {
    const agent = agentOf(buildConversationRequest({ ...input, condensing: CONDENSING }));
    expect(agent.condenser).toEqual({
      kind: 'LLMSummarizingCondenser',
      llm: {
        model: 'litellm_proxy/gpt-oss-20b',
        base_url: 'http://litellm:4000',
        api_key: VIRTUAL_KEY,
        usage_id: CONDENSER_USAGE_ID,
      },
      max_size: 120,
      keep_first: 2,
      // 75 % of the context: room for the system prompt, the tools and the reply.
      max_tokens: 24576,
    });
    // Same model and key as the agent: the seven labels and the run budget apply to both.
    expect(agent.condenser?.llm).toMatchObject({
      model: agent.llm.model,
      base_url: agent.llm.base_url,
      api_key: agent.llm.api_key,
    });
    expect(agent.llm.max_input_tokens).toBe(32768);
    expect(agent.llm.usage_id).toBe('agent');
  });

  it('still refuses a model outside allowed_models with condensing on', () => {
    expect(() =>
      buildConversationRequest({ ...input, model: 'other-model', condensing: CONDENSING }),
    ).toThrow();
  });
});

describe('condensingFor (AC2)', () => {
  const config = (
    mode: 'off' | 'summarize',
    sizes: Record<string, number> = { 'gpt-oss-20b': 32768 },
  ): ProjectConfig['run']['context_condensing'] => ({
    mode,
    max_events: 80,
    keep_first: 3,
    model_context_tokens: sizes,
  });

  it('lists every state', () => {
    expect(CONDENSING_STATES).toEqual(['off', 'summarize', 'context_unknown', 'unsupported']);
  });

  it('is off when the project does not condense', () => {
    expect(condensingFor(config('off'), 'openhands', 'gpt-oss-20b')).toEqual({ state: 'off' });
  });

  it("gives the OpenHands adapter the configured limits and the model's size", () => {
    expect(condensingFor(config('summarize'), 'openhands', 'gpt-oss-20b')).toEqual({
      state: 'summarize',
      condensing: { maxEvents: 80, keepFirst: 3, contextTokens: 32768 },
    });
  });

  it('is never on when the context size of the run model is unknown (rule M35)', () => {
    expect(condensingFor(config('summarize'), 'openhands', 'claude-haiku-4-5-20251001')).toEqual({
      state: 'context_unknown',
    });
    // An inherited property is not a context size.
    expect(condensingFor(config('summarize', {}), 'openhands', 'toString')).toEqual({
      state: 'context_unknown',
    });
  });

  it('is unsupported for OpenCode, which keeps its own behaviour (QUESTIONS #554)', () => {
    expect(condensingFor(config('summarize'), 'opencode', 'gpt-oss-20b')).toEqual({
      state: 'unsupported',
    });
  });
});

const action = (command: string) => ({
  kind: 'ActionEvent',
  tool_name: 'terminal',
  tool_call: { arguments: JSON.stringify({ command }) },
});
const condensation = (forgotten: number, summary: unknown = SUMMARY) => ({
  kind: 'Condensation',
  forgotten_event_ids: Array.from({ length: forgotten }, (_, i) => `e${String(i)}`),
  summary,
  summary_offset: 2,
  llm_response_id: 'r1',
});

describe('counts with condensing (AC3, AC4)', () => {
  const log = [
    { kind: 'MessageEvent' },
    action('ls'),
    { kind: 'ObservationEvent' },
    { kind: 'CondensationRequest' },
    condensation(5),
    { kind: 'CondensationSummaryEvent', summary: SUMMARY },
    action('ls'),
    condensation(3),
    action('ls'),
  ];

  it('counts condensations and the events they removed from the view', () => {
    expect(condensingCounts(log)).toEqual({ condensations: 2, eventsForgotten: 8 });
    // The summary of an earlier condensation is in the view only: not an event of the log.
    expect(
      condensingCounts([{ kind: 'Condensation', forgotten_event_ids: ['c1-summary', 'e7', 'e8'] }]),
    ).toEqual({ condensations: 1, eventsForgotten: 2 });
    expect(condensingCounts([{ kind: 'Condensation' }])).toEqual({
      condensations: 1,
      eventsForgotten: 0,
    });
  });

  it('does not count the condenser events as progress', () => {
    expect(progressEvents(log)).toBe(5);
  });

  it('still sees identical tool calls through condensations (loop detection)', () => {
    expect(trailingIdenticalCalls(log)).toBe(3);
  });
});

describe('the log without summaries (QUESTIONS #551)', () => {
  it('replaces each summary with its SHA-256 and length', () => {
    const [out, summaryEvent] = withoutSummaries([
      condensation(2),
      { kind: 'CondensationSummaryEvent', summary: SUMMARY },
    ]);
    const sha = createHash('sha256').update(SUMMARY, 'utf8').digest('hex');
    expect(out).toEqual({
      ...condensation(2),
      summary: null,
      summary_sha256: sha,
      summary_chars: SUMMARY.length,
    });
    expect(summaryEvent).toEqual({
      kind: 'CondensationSummaryEvent',
      summary: null,
      summary_sha256: sha,
      summary_chars: SUMMARY.length,
    });
    expect(JSON.stringify([out, summaryEvent])).not.toContain('secret-client-file');
  });

  it('drops a summary that is not text, and keeps other events as they are', () => {
    const other = { kind: 'MessageEvent', summary: 'not a condenser summary' };
    expect(
      withoutSummaries([condensation(1, { text: SUMMARY }), condensation(1, null), other]),
    ).toEqual([
      { ...condensation(1), summary: null },
      { ...condensation(1), summary: null },
      other,
    ]);
  });
});

describe('OpenHandsAdapter with condensing', () => {
  const log = [
    action('ls'),
    { kind: 'CondensationRequest' },
    condensation(4),
    action('pwd'),
    { kind: 'ObservationEvent' },
  ];
  const handle: AgentRunHandle = {
    runId: CONTRACT.run_id,
    conversationId: CONVERSATION_ID,
    endpoint: { baseUrl: 'http://sdlc-sandbox-x:8000', sessionKey: secret(SESSION_KEY) },
    workingDir: '/workspace',
  };

  function adapterWith(status: string) {
    const bodies: unknown[] = [];
    const fetchFn = ((url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
      const body = path.endsWith('/events/search')
        ? { items: log, next_page_id: null }
        : path === '/api/bash/execute_bash_command'
          ? { exit_code: 0, stdout: `sdlc:head:${'a'.repeat(40)}\nsdlc:changes\nsdlc:end\n` }
          : { id: CONVERSATION_ID, execution_status: status };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as typeof fetch;
    return { bodies, adapter: new OpenHandsAdapter({ fetch: fetchFn }) };
  }

  it('sends the condenser when the runner asks for it', async () => {
    const { bodies, adapter } = adapterWith('running');
    await adapter.startRun({
      contract: CONTRACT,
      endpoint: handle.endpoint,
      model: {
        model: 'gpt-oss-20b',
        baseUrl: 'http://litellm:4000',
        virtualKey: secret(VIRTUAL_KEY),
      },
      task: TASK,
      workingDir: '/workspace',
      condensing: CONDENSING,
    });
    expect(agentOf(bodies[0] as Record<string, unknown>).condenser).toMatchObject({
      kind: 'LLMSummarizingCondenser',
      max_size: 120,
    });
  });

  it('reports steps, progress and condensing counts, never a summary', async () => {
    const { adapter } = adapterWith('running');
    const status = await adapter.getStatus(handle);
    expect(status).toEqual({
      state: 'running',
      iterations: 2,
      events: 3,
      identicalCalls: 1,
      condensations: 1,
      eventsForgotten: 4,
    });
    expect(JSON.stringify(status)).not.toContain('secret-client-file');
  });

  it('hands over the log without summary text', async () => {
    const { adapter } = adapterWith('finished');
    const outputs = await adapter.collectOutputs(handle, CONTRACT.base_sha);
    expect(outputs.events).toHaveLength(5);
    expect(outputs.iterations).toBe(2);
    expect(JSON.stringify(outputs.events)).not.toContain('secret-client-file');
  });
});
