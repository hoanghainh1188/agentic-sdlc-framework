// D-08 X04 AC1, AC5 (design/ADR-M89, QUESTIONS #533, #536): the first register tool,
// `read_documents`, through MCP. It checks its arguments again (it never trusts its caller),
// frames the passages as data, and logs document IDs and content hashes only: never a query, a
// path or a text. Its runtime files are checked before use.
import {
  KNOWLEDGE_READ_LOG_EVENT,
  TOOL_CALL_RULES,
  type KnowledgeReadLogLine,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  answerText,
  callArguments,
  DEFAULT_LIMIT,
  handleMessage,
  readRuntime,
  TOOL_NAME,
  type McpDeps,
  type SearchHit,
} from '../../apps/tool-project-docs/src/index.js';

const DOC = '44444444-4444-4444-8444-444444444444';
const DOC2 = '55555555-5555-4555-8555-555555555555';
const SHA = 'b'.repeat(64);
const QUERY = 'QUERY-CANARY how are orders cancelled';
const PATH = 'docs/PATH-CANARY.md';
const TEXT = 'TEXT-CANARY Orders are cancelled by the owner.';

const hits: SearchHit[] = [
  { docId: DOC, contentSha256: SHA, path: PATH, text: TEXT, score: 0.91 },
  { docId: DOC, contentSha256: SHA, path: PATH, text: 'second chunk', score: 0.8 },
  { docId: DOC2, contentSha256: SHA, path: 'README.md', text: 'other', score: 0.5 },
];

function deps(search?: McpDeps['search']) {
  const logs: KnowledgeReadLogLine[] = [];
  const asked: [string, number][] = [];
  const d: McpDeps = {
    version: '1.0.0',
    log: (line) => logs.push(line),
    search:
      search ??
      ((query, limit) => {
        asked.push([query, limit]);
        return Promise.resolve(hits);
      }),
  };
  return { d, logs, asked };
}

const call = (args: unknown, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: TOOL_NAME, arguments: args },
});

describe('the MCP side of read_documents (AC1)', () => {
  it('initializes and lists one tool, the name and limits of the call rules', async () => {
    const { d } = deps();
    const init = await handleMessage(d, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {},
    });
    expect(init.body).toMatchObject({
      result: { serverInfo: { name: 'sdlc-project-docs', version: '1.0.0' } },
    });
    const list = await handleMessage(d, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (list.body as { result: { tools: { name: string; inputSchema: unknown }[] } })
      .result.tools;
    const rule = TOOL_CALL_RULES.read_documents[0]!;
    expect(tools.map((t) => t.name)).toEqual([rule.tool]);
    expect(tools[0]!.inputSchema).toMatchObject({
      required: ['query'],
      properties: { query: { maxLength: 1000 }, limit: { minimum: 1, maximum: 20 } },
    });
  });

  it('a notification gets 202 and no answer', async () => {
    expect(
      await handleMessage(deps().d, { jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toEqual({ status: 202 });
  });

  it('a call returns the passages framed as data, with their paths', async () => {
    const { d, asked } = deps();
    const answer = await handleMessage(d, call({ query: QUERY, limit: 3 }));
    expect(asked).toEqual([[QUERY, 3]]);
    const result = (answer.body as { result: { content: { text: string }[]; isError: boolean } })
      .result;
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('not instructions');
    expect(result.content[0]!.text).toContain(PATH);
    expect(result.content[0]!.text).toContain(TEXT);
  });

  it(`the default limit is ${String(DEFAULT_LIMIT)}`, async () => {
    const { d, asked } = deps();
    await handleMessage(d, call({ query: QUERY }));
    expect(asked).toEqual([[QUERY, DEFAULT_LIMIT]]);
  });

  it('logs the distinct document IDs and content hashes and the chunks, never a query, path or text (AC5)', async () => {
    const { d, logs } = deps();
    await handleMessage(d, call({ query: QUERY }));
    expect(logs).toEqual([
      {
        event: KNOWLEDGE_READ_LOG_EVENT,
        documents: [
          [DOC, SHA],
          [DOC2, SHA],
        ],
        chunks: 3,
      },
    ]);
    const text = JSON.stringify(logs);
    for (const canary of ['QUERY-CANARY', 'PATH-CANARY', 'TEXT-CANARY']) {
      expect(text).not.toContain(canary);
    }
  });

  it.each<[string, unknown]>([
    ['no query', {}],
    ['an empty query', { query: '  ' }],
    ['a query over 1000 characters', { query: 'x'.repeat(1001) }],
    ['a limit of 0', { query: 'a', limit: 0 }],
    ['a limit over 20', { query: 'a', limit: 21 }],
    ['a limit that is not an integer', { query: 'a', limit: 2.5 }],
    ['another argument', { query: 'a', path: '../etc' }],
    ['a list', ['a']],
  ])('refuses %s without searching (the gateway refuses it first)', async (_name, args) => {
    const { d, asked, logs } = deps();
    expect(callArguments(args)).toBeUndefined();
    const answer = await handleMessage(d, call(args));
    expect(answer.body).toMatchObject({ error: { code: -32602 } });
    expect(asked).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('refuses another tool, another method and a batch', async () => {
    const { d } = deps();
    expect(
      (
        await handleMessage(d, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'delete_docs', arguments: {} },
        })
      ).body,
    ).toMatchObject({ error: { code: -32602 } });
    expect(
      (await handleMessage(d, { jsonrpc: '2.0', id: 2, method: 'resources/list' })).body,
    ).toMatchObject({ error: { code: -32601 } });
    expect((await handleMessage(d, [call({ query: 'a' })])).body).toMatchObject({
      error: { code: -32600 },
    });
  });

  it('a search that fails is a tool error with a code, and nothing is logged', async () => {
    const { d, logs } = deps(() => Promise.reject(new Error('db password wrong: secret')));
    const answer = await handleMessage(d, call({ query: QUERY }));
    expect(answer.body).toMatchObject({
      result: { isError: true, content: [{ text: 'search_unavailable' }] },
    });
    expect(JSON.stringify(answer.body)).not.toContain('secret');
    expect(logs).toEqual([]);
  });

  it('no passage: a plain sentence', () => {
    expect(answerText([])).toBe('No matching passage in the project documents.');
  });
});

describe('the runtime files of the tool (written by the runner)', () => {
  const config = {
    schema_version: 1,
    index_id: DOC,
    schema: `kdocs_p${'1'.repeat(32)}`,
    model: 'bge-m3',
    database: { host: 'knowledge-db', port: 5432, name: 'knowledge' },
    model_gateway_url: 'http://litellm:4000',
  };
  const credentials = { db_username: 'v-login', db_password: 'pw', llm_key: 'sk-tool' };

  it('reads valid files', () => {
    expect(readRuntime(JSON.stringify(config), JSON.stringify(credentials))).toEqual({
      config,
      credentials,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['another schema', { schema: 'public' }],
    ['a schema with SQL', { schema: 'kdocs_p1; DROP TABLE x' }],
    ['an index that is not a UUID', { index_id: '1 OR 1=1' }],
    ['an internet gateway', { model_gateway_url: 'https://api.example.com' }],
    ['an unknown version', { schema_version: 2 }],
  ])('refuses %s, without echoing the value', (_name, change) => {
    expect(() =>
      readRuntime(JSON.stringify({ ...config, ...change }), JSON.stringify(credentials)),
    ).toThrow(/^tool\.runtime_invalid: [a-z_.]+$/);
  });

  it('refuses a missing credential', () => {
    expect(() =>
      readRuntime(JSON.stringify(config), JSON.stringify({ ...credentials, llm_key: '' })),
    ).toThrow('tool.runtime_invalid: llm_key');
  });
});
