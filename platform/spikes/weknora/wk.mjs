// K01 spike: a small client for the WeKnora v0.8.2 REST API (base /api/v1), through the gateway on 127.0.0.1.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './corpus.mjs';

export const API = process.env.K01_API ?? 'http://127.0.0.1:32080/api/v1';
export const LITELLM = process.env.K01_LITELLM ?? 'http://127.0.0.1:32040';

/** Throw-away secrets written by up.sh (never printed). */
export function secrets() {
  const env = {};
  for (const line of readFileSync(join(stateDir(), 'secrets.env'), 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

export async function call(method, path, { token, apiKey, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey) headers['X-API-Key'] = apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

export async function login(user) {
  const { json } = await call('POST', '/auth/login', {
    body: { email: `tenant-${user}@k01.invalid`, password: secrets().K01_USER_PASSWORD },
  });
  if (!json.token) throw new Error(`login failed for ${user}`);
  return { token: json.token, tenantId: json.user.tenant_id };
}

export async function hybridSearch(token, kbId, query, n = 5, extra = {}) {
  const t0 = performance.now();
  const r = await call('POST', `/knowledge-bases/${kbId}/hybrid-search`, {
    token,
    body: { query_text: query, match_count: n, ...extra },
  });
  return {
    ms: performance.now() - t0,
    status: r.status,
    items: Array.isArray(r.json.data) ? r.json.data : [],
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
