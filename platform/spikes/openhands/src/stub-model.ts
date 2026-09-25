// Stub model for the C01 spike: a minimal OpenAI-compatible chat completions server.
// LiteLLM routes the model alias `poc-stub` here (litellm.poc.yaml). Runs in a `node:24` container
// on the internal sandbox network: `node src/stub-model.ts` (Node 24 strips the types).
// It never calls out and holds no secrets.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { scriptedReply, type ChatRequest, type ScriptedReply } from './stub-script.ts';

const PORT = Number(process.env['PORT'] ?? '8080');
const MAX_BODY_BYTES = 5 * 1024 * 1024;

let requestCount = 0;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function completion(model: string, reply: ScriptedReply) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-poc-${requestCount}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        finish_reason: reply.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        message: { role: 'assistant', content: reply.content, tool_calls: reply.toolCalls },
      },
    ],
    // Fixed usage, so LiteLLM computes a non-zero cost from the per-token price in its config.
    usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
  };
}

function sendStream(res: ServerResponse, model: string, reply: ScriptedReply): void {
  const base = { id: `chatcmpl-poc-${requestCount}`, object: 'chat.completion.chunk', model };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = {
    role: 'assistant',
    content: reply.content,
    tool_calls: reply.toolCalls.map((c, index) => ({ index, ...c })),
  };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta }] })}\n\n`);
  const finish = reply.toolCalls.length > 0 ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
  const last = { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage };
  res.write(`data: ${JSON.stringify(last)}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function handleCompletion(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = JSON.parse(await readBody(req)) as ChatRequest & { stream?: boolean };
  requestCount += 1;
  const reply = scriptedReply(request);
  const names = reply.toolCalls.map((c) => c.function.name).join(',');
  console.log(`stub request=${requestCount} tools=${names} delay_ms=${reply.delayMs}`);
  if (reply.delayMs > 0) await new Promise((r) => setTimeout(r, reply.delayMs));
  const model = request.model ?? 'poc-stub';
  if (request.stream) sendStream(res, model, reply);
  else sendJson(res, 200, completion(model, reply));
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { status: 'ok', requests: requestCount });
    return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    handleCompletion(req, res).catch((error: unknown) => {
      console.error(`stub error: ${error instanceof Error ? error.message : String(error)}`);
      sendJson(res, 400, { error: { message: 'bad request' } });
    });
    return;
  }
  sendJson(res, 404, { error: { message: 'not found' } });
});

server.listen(PORT, () => console.log(`stub model listening on ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
