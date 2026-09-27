// Scripted OpenAI-compatible model for the C05 live test (no provider, no real key). It stands in
// for LiteLLM on the run's network (alias `litellm`), and answers only with the run's virtual key
// (STUB_EXPECTED_KEY), so a successful run proves the key reached the agent through the API.
// Ported from the C01 spike (platform/spikes/openhands/src/stub-script.ts).
//
// The script is chosen by a marker in the first user message (the plan summary):
//   [stub:edit]  create hello.txt with file_editor, then finish
//   [stub:loop]  run the same terminal command forever (iteration cap)
//   [stub:slow]  like edit, but every reply waits 120 s (time cap: interrupt)
// It logs `stub:check:<name>:<yes|no>` for what the first request contained, never the content.
import http from 'node:http';

const expected = process.env.STUB_EXPECTED_KEY ?? '';
if (expected.length < 16) throw new Error('STUB_EXPECTED_KEY is missing or too short');
const CANARY = process.env.STUB_AGENTS_CANARY ?? '';

let calls = 0;
const checked = new Set();

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ')
      : '';

function check(request) {
  const firstUser = textOf(request.messages.find((m) => m.role === 'user')?.content);
  const all = request.messages.map((m) => textOf(m.content)).join('\n');
  const checks = {
    spec_path: firstUser.includes('docs/specs/T01-labels.md'),
    planned_file: firstUser.includes('- hello.txt'),
    agents_md_named: firstUser.includes('AGENTS.md'),
    agents_md_loaded: CANARY !== '' && all.includes(CANARY),
    tools: (request.tools ?? [])
      .map((t) => t.function.name)
      .sort()
      .join(','),
  };
  for (const [name, value] of Object.entries(checks)) {
    const line = `stub:check:${name}:${typeof value === 'boolean' ? (value ? 'yes' : 'no') : value}`;
    if (!checked.has(line)) console.log(line);
    checked.add(line);
  }
}

function placeholder(schema) {
  if (!schema) return '';
  if (schema.enum?.length) return schema.enum[0];
  const first = schema.anyOf?.find((s) => s.type !== 'null');
  if (first) return placeholder(first);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  return { integer: 0, number: 0, boolean: false, array: [], object: {} }[type] ?? '';
}

function call(request, step, name, args) {
  const params = request.tools?.find((t) => t.function.name === name)?.function.parameters;
  const filled = { ...args };
  for (const key of params?.required ?? []) {
    if (!(key in filled)) filled[key] = placeholder(params?.properties?.[key]);
  }
  return {
    id: `call_c05_${step}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(filled) },
  };
}

function reply(request) {
  const first = textOf(request.messages.find((m) => m.role === 'user')?.content);
  const script = first.includes('[stub:loop]')
    ? 'loop'
    : first.includes('[stub:slow]')
      ? 'slow'
      : 'edit';
  const step = request.messages.filter((m) => m.role === 'assistant').length;
  const delayMs = script === 'slow' ? 120_000 : 0;
  if (script === 'loop')
    return { delayMs, toolCalls: [call(request, step, 'terminal', { command: 'ls' })] };
  if (step === 0) {
    return {
      delayMs,
      toolCalls: [
        call(request, step, 'file_editor', {
          command: 'create',
          path: '/workspace/hello.txt',
          file_text: 'Hello from the C05 stub model.\n',
        }),
      ],
    };
  }
  return { delayMs, toolCalls: [call(request, step, 'finish', { message: 'C05 stub: done.' })] };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, calls });
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    return send(res, 404, { error: { message: 'not found' } });
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    console.log('stub:refused:wrong_key');
    return send(res, 401, { error: { message: 'wrong key', type: 'auth' } });
  }
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    calls += 1;
    const request = JSON.parse(raw || '{}');
    check(request);
    const { delayMs, toolCalls } = reply(request);
    console.log(`stub:call:${calls}:${toolCalls.map((c) => c.function.name).join(',')}`);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const model = request.model ?? 'stub-model';
    const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
    const message = { role: 'assistant', content: null, tool_calls: toolCalls };
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: `chatcmpl-c05-${calls}`, object: 'chat.completion.chunk', model };
      const delta = { ...message, tool_calls: toolCalls.map((c, index) => ({ index, ...c })) };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta }] })}\n\n`);
      const last = {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage,
      };
      res.write(`data: ${JSON.stringify(last)}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    send(res, 200, {
      id: `chatcmpl-c05-${calls}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, finish_reason: 'tool_calls', message }],
      usage,
    });
  });
});

server.listen(4000, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
