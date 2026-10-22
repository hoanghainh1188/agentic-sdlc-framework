// X14 spike (design/ADR-M87): a stub MCP tool over Streamable HTTP, no dependencies.
// Two tools: `search_docs` (the kind X04 builds) and `delete_docs` (a tool the policy must refuse).
// Every answer holds the answer canary, so a log that holds an answer is found by grep.
// GET /stats returns how many calls reached the tool: the gateway must forward allowed calls only.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8080);
const ANSWER_CANARY = 'X14ANSWERCANARY';
const calls = { search_docs: 0, delete_docs: 0 };

const TOOLS = [
  {
    name: 'search_docs',
    description: 'Search the project documents',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    },
  },
  {
    name: 'delete_docs',
    description: 'Delete project documents (must never be reachable)',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  },
];

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return result(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'x14-stub-tool', version: '0.0.1' },
      });
    case 'tools/list':
      return result(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!(name in calls)) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } };
      }
      calls[name] += 1;
      return result(msg.id, {
        content: [{ type: 'text', text: `doc-1 doc-2 ${ANSWER_CANARY}` }],
        isError: false,
      });
    }
    case 'ping':
      return result(msg.id, {});
    default:
      if (msg.id === undefined) return undefined; // a notification
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
  }
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(calls));
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method === 'DELETE') {
    res.writeHead(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const out = Array.isArray(msg) ? msg.map(handle).filter(Boolean) : handle(msg);
    const headers = { 'content-type': 'application/json' };
    if (!Array.isArray(msg) && msg.method === 'initialize')
      headers['mcp-session-id'] = randomUUID();
    if (out === undefined || (Array.isArray(out) && out.length === 0)) {
      res.writeHead(202, headers).end();
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '0.0.0.0');
