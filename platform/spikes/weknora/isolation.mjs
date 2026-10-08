// K01 spike: workspace isolation and the built-in MCP endpoints (/mcp/:endpoint_id). Writes results/isolation.json
// (pass/fail per check, status codes; no tokens, no text). Every MCP endpoint made here is deleted at the end.
import { writeFileSync } from 'node:fs';
import { API, call, hybridSearch, login } from './wk.mjs';

const ORIGIN = API.replace(/\/api\/v1$/, '');
const READ_TOOLS = [
  'list_knowledge_bases',
  'search_knowledge',
  'grep_chunks',
  'list_documents',
  'read_document',
];

async function mcp(endpointId, token, method, params, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(`${ORIGIN}/mcp/${endpointId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.includes('data:')
    ? text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5))
        .join('')
    : text;
  let json = null;
  try {
    json = JSON.parse(data);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, session: res.headers.get('mcp-session-id') };
}

async function open(endpointId, token) {
  const init = await mcp(endpointId, token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'k01', version: '0' },
  });
  if (init.status !== 200) return { status: init.status };
  await fetch(`${ORIGIN}/mcp/${endpointId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      ...(init.session ? { 'Mcp-Session-Id': init.session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return { status: 200, session: init.session };
}

async function tool(endpointId, token, session, name, args) {
  const r = await mcp(endpointId, token, 'tools/call', { name, arguments: args }, session);
  const content = r.json?.result?.content?.map((c) => c.text ?? '').join('\n') ?? '';
  return { status: r.status, isError: Boolean(r.json?.error || r.json?.result?.isError), content };
}

const checks = {};
const a = await login('a');
const b = await login('b');
const kbsA = (await call('GET', '/knowledge-bases', { token: a.token })).json.data;
const kbsB = (await call('GET', '/knowledge-bases', { token: b.token })).json.data;
const kbA = kbsA.find((k) => k.name === 'k01-bilingual');
const kbSplit = kbsA.find((k) => k.name === 'k01-split');
let kbB = kbsB.find((k) => k.name === 'k01-decoy');
if (!kbB) {
  // setup.mjs makes it after the corpora; make it here when isolation runs first.
  kbB = (
    await call('POST', '/knowledge-bases', {
      token: b.token,
      body: { name: 'k01-decoy', embedding_model_id: 'k01-embed' },
    })
  ).json.data;
  const form = new FormData();
  form.append(
    'file',
    new Blob(['# Tenant B only\n\nThe decoy passphrase of tenant B is zebra-orchid-17.\n'], {
      type: 'text/markdown',
    }),
    'decoy.md',
  );
  await call('POST', `/knowledge-bases/${kbB.id}/knowledge/file`, { token: b.token, form });
  for (
    let i = 0;
    i < 60 && (await hybridSearch(b.token, kbB.id, 'decoy passphrase')).items.length === 0;
    i++
  )
    await new Promise((r) => setTimeout(r, 5000));
}
checks.decoy_visible_to_owner = (
  await hybridSearch(b.token, kbB.id, 'decoy passphrase zebra')
).items.some((i) => (i.content ?? '').includes('zebra-orchid-17'));

// REST: a user of tenant A cannot see or search tenant B's knowledge base.
checks.rest_list_other_tenant_hidden = !kbsA.some((k) => k.id === kbB.id);
checks.rest_get_other_tenant_kb_status = (
  await call('GET', `/knowledge-bases/${kbB.id}`, { token: a.token })
).status;
const crossSearch = await hybridSearch(a.token, kbB.id, 'decoy passphrase zebra');
checks.rest_search_other_tenant_status = crossSearch.status;
checks.rest_search_other_tenant_leaks = crossSearch.items.some((i) =>
  (i.content ?? '').includes('zebra-orchid-17'),
);

// MCP endpoint of tenant A: read tools only, bounded to k01-bilingual.
const created = await call('POST', '/mcp-endpoints', {
  token: a.token,
  body: {
    name: 'k01-run',
    enabled: true,
    knowledge_base_ids: [kbA.id],
    tools: READ_TOOLS,
    rate_limit_per_minute: 60,
  },
});
const ep = created.json.data?.endpoint ?? created.json.data;
const token = created.json.data?.token ?? created.json.data?.plaintext_token ?? created.json.token;
checks.mcp_endpoint_created = created.status;
checks.mcp_token_shown_once_prefix_ok = typeof token === 'string' && token.startsWith('mcp_');
checks.mcp_token_not_stored_plain = !JSON.stringify(
  (await call('GET', `/mcp-endpoints/${ep.id}`, { token: a.token })).json,
).includes(token);

const s = await open(ep.id, token);
checks.mcp_initialize_status = s.status;
const listed = await mcp(ep.id, token, 'tools/list', {}, s.session);
const names = (listed.json?.result?.tools ?? []).map((t) => t.name).sort();
checks.mcp_tools_listed = names;
checks.mcp_only_allowlisted_tools = names.every((n) => READ_TOOLS.includes(n));

const ok = await tool(ep.id, token, s.session, 'search_knowledge', {
  query: '注文を取り消せる状態',
  knowledge_base_ids: [kbA.id],
});
checks.mcp_search_own_kb_ok = !ok.isError && ok.content.length > 0;
const otherKb = await tool(ep.id, token, s.session, 'search_knowledge', {
  query: '注文を取り消せる状態',
  knowledge_base_ids: [kbSplit.id],
});
checks.mcp_search_kb_outside_scope_refused =
  otherKb.isError || !otherKb.content.includes('キャンセル');
const otherTenant = await tool(ep.id, token, s.session, 'search_knowledge', {
  query: 'decoy passphrase zebra',
  knowledge_base_ids: [kbB.id],
});
checks.mcp_search_other_tenant_leaks = otherTenant.content.includes('zebra-orchid-17');
const write = await tool(ep.id, token, s.session, 'add_document', {
  knowledge_base_id: kbA.id,
  title: 'x',
  content: 'x',
});
checks.mcp_write_tool_refused = write.isError;
const ask = await tool(ep.id, token, s.session, 'ask', { query: 'hello' });
checks.mcp_chat_tool_refused = ask.isError;

checks.mcp_no_token_status = (await mcp(ep.id, null, 'tools/list', {})).status;
checks.mcp_wrong_token_status = (
  await mcp(ep.id, `mcp_${'0'.repeat(40)}`, 'tools/list', {})
).status;

// Tenant B cannot manage tenant A's endpoint; deleting it revokes the token at once.
checks.mcp_other_tenant_delete_status = (
  await call('DELETE', `/mcp-endpoints/${ep.id}`, { token: b.token })
).status;
checks.mcp_delete_status = (
  await call('DELETE', `/mcp-endpoints/${ep.id}`, { token: a.token })
).status;
checks.mcp_deleted_token_status = (await mcp(ep.id, token, 'tools/list', {}, s.session)).status;

console.log(JSON.stringify(checks, null, 2));
writeFileSync(
  new URL('./results/isolation.json', import.meta.url),
  JSON.stringify(checks, null, 2) + '\n',
);
