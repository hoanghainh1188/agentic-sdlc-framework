// Stub MCP tool of the X04 live test: no dependencies, Streamable HTTP, JSON answers. Every answer
// holds the answer canary, so a log that holds an answer is found by a search. GET /stats returns
// how many calls reached the tool: the gateway must forward allowed calls only.
import { createServer } from 'node:http';

const ANSWER_CANARY = 'X04ANSWERCANARY';
const calls = { search_project_docs: 0, delete_docs: 0 };
const TOOLS = [
  {
    name: 'search_project_docs',
    description: 'Search the project documents',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    },
  },
  { name: 'delete_docs', description: 'Never allowed', inputSchema: { type: 'object' } },
];

function answer(msg) {
  if (msg.method === 'initialize') {
    return {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'x04-stub-tool', version: '0.0.1' },
    };
  }
  if (msg.method === 'tools/list') return { tools: TOOLS };
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name in calls) calls[name] += 1;
    return { content: [{ type: 'text', text: `${ANSWER_CANARY} ${name}` }], isError: false };
  }
  return {};
}

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return res.writeHead(200).end('ok');
  if (req.method === 'GET' && req.url === '/stats') {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(calls));
  }
  if (req.method !== 'POST') return res.writeHead(405).end();
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return res.writeHead(400).end();
    }
    if (msg.id === undefined) return res.writeHead(202).end();
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'stub' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer(msg) }));
  });
}).listen(8080, '0.0.0.0');
