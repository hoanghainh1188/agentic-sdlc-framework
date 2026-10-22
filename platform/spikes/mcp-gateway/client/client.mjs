// X14 spike (design/ADR-M87): the stand-in for the sandbox. It sits on the run network only and
// calls the tool through the gateway. It prints one JSON line per scenario: codes and counts only.
//   GW_URL=http://gateway:3000/mcp KEY=<per-run key> CAP=<calls allowed> TOOL_URL=http://tool:8080
const GW_URL = process.env.GW_URL;
const KEY = process.env.KEY;
const HEADER = process.env.KEY_HEADER ?? 'authorization';
const PREFIX = process.env.KEY_PREFIX ?? 'Bearer ';
const CAP = Number(process.env.CAP ?? 5);
const QUERY_CANARY = 'X14QUERYCANARY';

let rpcId = 0;

async function post(body, { key = KEY, session } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  if (key) headers[HEADER] = `${PREFIX}${key}`;
  if (session) headers['mcp-session-id'] = session;
  let res;
  try {
    res = await fetch(GW_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { status: 0, error: e.cause?.code ?? e.name };
  }
  const text = await res.text();
  let json;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    for (const d of data) {
      try {
        const j = JSON.parse(d);
        if (j.id === body.id) json = j;
      } catch {
        // not JSON: an SSE comment or keep-alive; the outcome then has no JSON-RPC body
      }
    }
  } else if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON: the outcome keeps the HTTP status only
    }
  }
  return { status: res.status, session: res.headers.get('mcp-session-id') ?? undefined, json };
}

async function open(key = KEY) {
  const init = await post(
    {
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'x14-client', version: '0' },
      },
    },
    { key },
  );
  if (init.status === 200 && init.json?.result) {
    await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { key, session: init.session },
    );
  }
  return init;
}

function outcome(r) {
  return {
    http: r.status,
    rpc_error: r.json?.error?.code ?? null,
    is_error: r.json?.result?.isError ?? null,
    ok: r.status === 200 && r.json?.result !== undefined && r.json.result.isError !== true,
  };
}

async function call(session, name, args) {
  return post(
    { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
    { session },
  );
}

function emit(scenario, data) {
  process.stdout.write(`${JSON.stringify({ scenario, ...data })}\n`);
}

async function main() {
  emit('no_key', outcome(await open(null)));
  emit('wrong_key', outcome(await open('not-the-run-key')));
  const init = await open();
  emit('initialize', outcome(init));
  const session = init.session;
  const list = await post(
    { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} },
    { session },
  );
  const names = (list.json?.result?.tools ?? []).map((t) => t.name);
  emit('tools_list', {
    ...outcome(list),
    tools: names.length,
    delete_listed: names.some((n) => /delete/.test(n)),
  });
  const search = names.find((n) => /search/.test(n)) ?? process.env.SEARCH_NAME ?? 'search_docs';
  const del = names.find((n) => /delete/.test(n)) ?? process.env.DELETE_NAME ?? 'delete_docs';
  emit(
    'allowed_call',
    outcome(await call(session, search, { query: `${QUERY_CANARY} first`, limit: 5 })),
  );
  emit('refused_tool', outcome(await call(session, del, { id: 'doc-1' })));
  emit(
    'refused_argument',
    outcome(await call(session, search, { query: `${QUERY_CANARY} big`, limit: 500 })),
  );
  // Calls up to the cap: one allowed call is done above; refused calls may or may not count.
  const results = [];
  for (let i = 0; i < CAP + 2; i += 1) {
    results.push(
      outcome(await call(session, search, { query: `${QUERY_CANARY} ${i}`, limit: 1 })).ok,
    );
  }
  emit('cap', {
    cap: CAP,
    ok_calls_after_first: results.filter(Boolean).length,
    first_refused_at: results.indexOf(false),
  });
  if (process.env.TOOL_URL) {
    let direct;
    try {
      const r = await fetch(`${process.env.TOOL_URL}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      direct = { http: r.status, reachable: true };
    } catch (e) {
      direct = { http: 0, reachable: false, error: e.cause?.code ?? e.name };
    }
    emit('tool_direct', direct);
  }
}

// LOAD=<n>: n sequential allowed calls in one session, for latency, CPU and memory under load.
async function load(n) {
  const init = await open();
  const list = await post(
    { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} },
    { session: init.session },
  );
  const search = (list.json?.result?.tools ?? []).map((t) => t.name).find((t) => /search/.test(t));
  const ms = [];
  let ok = 0;
  const failures = {};
  const start = Date.now();
  for (let i = 0; i < n; i += 1) {
    const t = performance.now();
    const o = outcome(
      await call(init.session, search, { query: `${QUERY_CANARY} ${i}`, limit: 1 }),
    );
    if (o.ok) ok += 1;
    else {
      const code = `${o.http}/${o.rpc_error ?? (o.is_error ? 'is_error' : '-')}`;
      failures[code] = (failures[code] ?? 0) + 1;
    }
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const pct = (p) => Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] * 10) / 10;
  emit('load', {
    calls: n,
    ok,
    failures,
    p50_ms: pct(0.5),
    p95_ms: pct(0.95),
    total_ms: Date.now() - start,
  });
}

(process.env.LOAD ? load(Number(process.env.LOAD)) : main()).catch((e) => {
  emit('client_failed', { error: e.name });
  process.exitCode = 1;
});
