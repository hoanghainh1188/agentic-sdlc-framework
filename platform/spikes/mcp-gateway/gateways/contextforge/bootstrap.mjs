// X14 spike: ContextForge has no static configuration for gateways, servers and tokens; they are
// created through its admin API after start. This runs on the run network (the runner has no
// network path to a run in the product: ADR-M25) and prints `<server id> <token>` on stdout.
const BASE = 'http://gateway:4444';
const { CF_EMAIL, CF_PASSWORD } = process.env;

async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const login = await api('POST', '/auth/email/login', null, {
  email: CF_EMAIL,
  password: CF_PASSWORD,
});
const admin = login.access_token;
await api('POST', '/gateways', admin, {
  name: 'docs',
  url: 'http://tool:8080/mcp',
  transport: 'STREAMABLEHTTP',
});
const tools = await api('GET', '/tools', admin);
const list = Array.isArray(tools) ? tools : (tools.items ?? tools.tools ?? []);
const search = list.find((t) => /search/.test(t.name ?? t.originalName ?? ''));
if (!search) throw new Error(`no search tool among ${list.length}`);
process.stderr.write(`tools: ${list.map((t) => t.name).join(',')}\n`);
const server = await api('POST', '/servers', admin, {
  server: { name: 'run-x14', associated_tools: [search.id], visibility: 'private' },
});
const token = await api('POST', '/tokens', admin, {
  name: 'run-x14',
  expires_in_days: 1,
  scope: { server_id: server.id, permissions: ['tools.read', 'tools.execute'] },
});
process.stdout.write(`${server.id} ${token.access_token ?? token.token}\n`);
