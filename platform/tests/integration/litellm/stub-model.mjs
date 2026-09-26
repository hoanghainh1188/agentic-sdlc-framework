// OpenAI-compatible stub model for the C03 live test (no real provider, no real key).
// It answers only when the request carries the throw-away provider key the test stored in
// OpenBao (STUB_EXPECTED_KEY). A call through LiteLLM that succeeds therefore proves that LiteLLM
// got the key from OpenBao through the sidecar (D-08 C03 AC1). Fixed usage per call:
// 1000 prompt tokens (200 of them cached) and 100 completion tokens.
import http from 'node:http';

const expected = process.env.STUB_EXPECTED_KEY ?? '';
if (expected.length < 16) throw new Error('STUB_EXPECTED_KEY is missing or too short');

let calls = 0;

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, calls });
  if (req.method === 'GET' && req.url === '/v1/models')
    return send(200, { object: 'list', data: [{ id: 'stub', object: 'model' }] });
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions'))
    return send(404, { error: { message: 'not found' } });
  if (req.headers.authorization !== `Bearer ${expected}`)
    return send(401, { error: { message: 'wrong provider key', type: 'auth' } });
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    calls += 1;
    const body = JSON.parse(raw || '{}');
    send(200, {
      id: `chatcmpl-stub-${Date.now()}-${calls}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'stub',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        prompt_tokens_details: { cached_tokens: 200 },
      },
    });
  });
});

server.listen(8080, '0.0.0.0');
