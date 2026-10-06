// Scripted OpenAI-compatible model for the C05 live test (no provider, no real key). It stands in
// for LiteLLM on the run's network (alias `litellm`), and answers only with the run's virtual key
// (STUB_EXPECTED_KEY), so a successful run proves the key reached the agent through the API.
// Ported from the C01 spike (platform/spikes/openhands/src/stub-script.ts).
//
// The script is chosen by a marker in the first user message (the plan summary):
//   [stub:edit]  create hello.txt with file_editor, then finish
//   [stub:loop]  run the same terminal command forever (iteration cap)
//   [stub:slow]  like edit, but every reply waits 120 s (time cap: interrupt)
//   [stub:repeat] the same terminal command forever, one reply every 2 s, so the runner's 1 s
//                poll sees every call (C11 PR 2: loop detection, identical tool calls)
//   [stub:silent] never answers within the test (600 s): no new agent event (C11 PR 2: no progress)
//   [stub:append] C09: appends one line to NOTES_FILE with the terminal, then finishes, so every
//                run (also a retry from the pushed commit) has a change inside the pilot plan
//   [stub:count]  C09: a different terminal command at every step, one reply a second, forever, so
//                the spend grows and loop detection never fires (budget warning and stop, N3)
//   [stub:live]   E07: appends one fixed, fictional line to LIVE_FILE (`docs/live-test/`), then
//                finishes: the live G1 → G8 test on the real pilot, which a person merges, never
//                touches the application code
// C09: with STUB_ADMIN_KEY set, the test registers and revokes run keys (`POST`/`DELETE
// /test/keys`, like the Cost Controller at LiteLLM), and `GET /key/info` answers a key's spend
// (STUB_PRICE_USD per call) and cap, as LiteLLM does for the runner's spend check. A revoked or
// unknown key gets 401; a key at its cap gets 400, as LiteLLM refuses it.
// E07: `GET /test/calls` (admin key) lists every counted call of a registered key (`key`, `n`,
// `at`), so the test's gateway returns one spend record per call, like LiteLLM's spend log.
// It logs `stub:check:<name>:<yes|no>` for what the first request contained, never the content.
import http from 'node:http';

const expected = process.env.STUB_EXPECTED_KEY ?? '';
const ADMIN_KEY = process.env.STUB_ADMIN_KEY ?? '';
if (expected.length < 16 && ADMIN_KEY.length < 16) {
  throw new Error('STUB_EXPECTED_KEY or STUB_ADMIN_KEY is missing or too short');
}
const CANARY = process.env.STUB_AGENTS_CANARY ?? '';
const PRICE = Number(process.env.STUB_PRICE_USD ?? '0.01');
const NOTES_FILE = '/workspace/apps/web/src/features/products/NOTES.md';
const LIVE_FILE = '/workspace/docs/live-test/RUNS.md';
const LIVE_LINE = 'One live test run of the SDLC platform (fictional text, no meaning).';

/** C09: the run keys the test registered: key → { maxBudget, calls, revoked }. */
const keys = new Map();
/** E07: every counted call of a registered key, in order. */
const callLog = [];
const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
const spendOf = (entry) => Math.round(entry.calls * PRICE * 1e6) / 1e6;

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
  const script =
    ['loop', 'slow', 'repeat', 'silent', 'append', 'count', 'live'].find((name) =>
      first.includes(`[stub:${name}]`),
    ) ?? 'edit';
  const step = request.messages.filter((m) => m.role === 'assistant').length;
  const delayMs = { slow: 120_000, repeat: 2_000, silent: 600_000, count: 1_000 }[script] ?? 0;
  if (script === 'count') {
    return {
      delayMs,
      toolCalls: [call(request, step, 'terminal', { command: `echo c09-${step}` })],
    };
  }
  if (script === 'append' && step === 0) {
    const dir = NOTES_FILE.slice(0, NOTES_FILE.lastIndexOf('/'));
    const command = `mkdir -p ${dir} && printf 'C09 stub note.\\n' >> ${NOTES_FILE}`;
    return { delayMs, toolCalls: [call(request, step, 'terminal', { command })] };
  }
  if (script === 'live' && step === 0) {
    const dir = LIVE_FILE.slice(0, LIVE_FILE.lastIndexOf('/'));
    const command = `mkdir -p ${dir} && printf '${LIVE_LINE}\\n' >> ${LIVE_FILE}`;
    return { delayMs, toolCalls: [call(request, step, 'terminal', { command })] };
  }
  if (script === 'loop' || script === 'repeat')
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
  if (req.url === '/test/keys' && ADMIN_KEY.length >= 16) return adminKeys(req, res);
  if (req.method === 'GET' && req.url === '/test/calls' && ADMIN_KEY.length >= 16) {
    if (req.headers.authorization !== `Bearer ${ADMIN_KEY}`) {
      return send(res, 401, { error: { message: 'wrong admin key' } });
    }
    return send(res, 200, { calls: callLog });
  }
  if (req.method === 'GET' && req.url === '/key/info') {
    const entry = keys.get(bearer(req));
    if (!entry || entry.revoked) return send(res, 401, { error: { message: 'invalid key' } });
    return send(res, 200, {
      key: 'hashed',
      info: { spend: spendOf(entry), max_budget: entry.maxBudget },
    });
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    return send(res, 404, { error: { message: 'not found' } });
  }
  const entry = keys.get(bearer(req));
  const known = expected.length >= 16 && req.headers.authorization === `Bearer ${expected}`;
  if (!known && (!entry || entry.revoked)) {
    console.log('stub:refused:wrong_key');
    return send(res, 401, { error: { message: 'wrong key', type: 'auth' } });
  }
  if (entry && entry.maxBudget !== null && spendOf(entry) >= entry.maxBudget) {
    console.log('stub:refused:budget');
    return send(res, 400, { error: { message: 'budget exceeded', type: 'budget_exceeded' } });
  }
  if (entry) {
    entry.calls += 1;
    callLog.push({ key: bearer(req), n: entry.calls, at: new Date().toISOString() });
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

/** C09: `POST` registers a run key with its cap, `DELETE` revokes it (admin key only). */
function adminKeys(req, res) {
  if (req.headers.authorization !== `Bearer ${ADMIN_KEY}`) {
    return send(res, 401, { error: { message: 'wrong admin key' } });
  }
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    if (typeof body.key !== 'string' || body.key.length < 16) {
      return send(res, 400, { error: { message: 'key' } });
    }
    if (req.method === 'POST') {
      const maxBudget = body.max_budget === null ? null : Number(body.max_budget);
      keys.set(body.key, { maxBudget, calls: 0, revoked: false });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      const known = keys.get(body.key);
      if (known) known.revoked = true;
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: { message: 'method' } });
  });
}

server.listen(4000, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
