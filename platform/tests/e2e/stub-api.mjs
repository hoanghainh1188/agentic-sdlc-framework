// A stub of the API for the dashboard's smoke test (U01 AC6, design/ADR-M54 §2.6). It serves the
// built dashboard through the api's own `registerDashboard` (the real file list and CSP) and
// answers the GET endpoints the dashboard reads with fixed, fictional data. Anything else: 405.
// Settings: SDLC_DASHBOARD_E2E_PORT, SDLC_DASHBOARD_E2E_TOKEN (made by the test at run time).
//
// U05 (ADR-M73 §2.2): on `localhost` (not on 127.0.0.1) GitHub sign-in is on. The stub plays the
// API and GitHub in one: `start` sets the pre-login cookie and sends the browser straight to the
// callback (GitHub "approves" at once); the tenant `demo` signs in, any other is refused. The
// cookies have the API's attributes; a request with a token and a cookie answers 400; sign-out
// needs the session cookie and the `localhost` origin. No real GitHub, no secret.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

import { loadDashboardFiles, registerDashboard } from '../../apps/api/dist/dashboard/static.js';
import { fixtures } from './fixtures.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const port = Number(process.env.SDLC_DASHBOARD_E2E_PORT ?? 4791);
const token = process.env.SDLC_DASHBOARD_E2E_TOKEN ?? '';
if (!/^sdlc_pat_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('SDLC_DASHBOARD_E2E_TOKEN');

/** The Fastify routes `registerDashboard` adds, kept in a list. */
const routes = [];
registerDashboard(
  { get: (pattern, handler) => routes.push({ pattern, handler }) },
  await loadDashboardFiles(path.join(root, 'platform/apps/dashboard/dist/web')),
);

function fastifyReply(res) {
  const reply = {
    header: (name, value) => (res.setHeader(name, value), reply),
    code: (status) => ((res.statusCode = status), reply),
    type: (contentType) => (res.setHeader('content-type', contentType), reply),
    redirect: (url, status) => (res.writeHead(status, { location: url }).end(), reply),
    send: (body) => (res.end(body), reply),
  };
  return reply;
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const error = (code) => ({ error: { code, message: code } });

const random = () => randomBytes(32).toString('base64url');
const LOCAL_ORIGIN = `http://localhost:${port}`;
/** Pending sign-ins: handle → { state, tenant }. Sessions: secret → true. */
const pending = new Map();
const sessions = new Set();

function cookieOf(req, name) {
  const found = (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return found.length === 1 ? found[0] : undefined;
}

const oauthCookie = (value, age) =>
  `__Host-sdlc_oauth=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${age}`;
const sessionCookie = (value, age) =>
  `__Host-sdlc_session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;

function redirect(res, location, cookies = []) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'set-cookie': cookies });
  res.end();
}

/** The sign-in endpoints of U05; true when the request was one of them. */
function signIn(req, res, url) {
  const github = (req.headers.host ?? '').startsWith('localhost:');
  if (url.pathname === '/v1/auth/config' && req.method === 'GET') {
    json(res, 200, { github });
    return true;
  }
  if (!github) return false;
  if (url.pathname === '/v1/auth/github/start' && req.method === 'GET') {
    const handle = random();
    const state = random();
    pending.set(handle, { state, tenant: url.searchParams.get('tenant') ?? '' });
    redirect(res, `/v1/auth/github/callback?code=demo&state=${state}`, [oauthCookie(handle, 600)]);
    return true;
  }
  if (url.pathname === '/v1/auth/github/callback' && req.method === 'GET') {
    const handle = cookieOf(req, '__Host-sdlc_oauth');
    const entry = handle && pending.get(handle);
    const clear = oauthCookie('', 0);
    if (!entry || entry.state !== url.searchParams.get('state') || entry.tenant !== 'demo') {
      redirect(res, '/dashboard/?signin=refused', [clear]);
      return true;
    }
    pending.delete(handle);
    const secret = random();
    sessions.add(secret);
    redirect(res, '/dashboard/', [clear, sessionCookie(secret, 28_800)]);
    return true;
  }
  const writes = { '/v1/auth/sign-out': 'POST', '/v1/me/sessions': 'DELETE' };
  if (writes[url.pathname] === req.method) {
    const secret = cookieOf(req, '__Host-sdlc_session');
    if (!secret || !sessions.has(secret)) return (json(res, 401, error('session_ended')), true);
    if (req.headers.origin !== LOCAL_ORIGIN) {
      return (json(res, 403, error('session_write_not_allowed')), true);
    }
    const ended = url.pathname === '/v1/me/sessions' ? sessions.size : 1;
    if (url.pathname === '/v1/me/sessions') sessions.clear();
    else sessions.delete(secret);
    res.writeHead(url.pathname === '/v1/me/sessions' ? 200 : 204, {
      'set-cookie': sessionCookie('', 0),
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(url.pathname === '/v1/me/sessions' ? JSON.stringify({ ended }) : undefined);
    return true;
  }
  return false;
}

/** The caller's credential: the token, a session cookie, or neither. Both: 400. */
function authenticate(req, res) {
  const bearer = req.headers.authorization;
  const secret = cookieOf(req, '__Host-sdlc_session');
  if (bearer !== undefined && secret !== undefined) {
    json(res, 400, error('credentials_ambiguous'));
    return false;
  }
  if (secret !== undefined) {
    if (sessions.has(secret)) return true;
    res.setHeader('set-cookie', sessionCookie('', 0));
    json(res, 401, error('session_ended'));
    return false;
  }
  if (bearer === `Bearer ${token}`) return true;
  json(res, 401, error('unauthorized'));
  return false;
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
      const route =
        url.pathname === '/dashboard'
          ? routes.find((r) => r.pattern === '/dashboard')
          : routes.find((r) => r.pattern === '/dashboard/*');
      const rest = url.pathname === '/dashboard' ? '' : url.pathname.slice('/dashboard/'.length);
      route.handler({ params: { '*': rest }, headers: req.headers }, fastifyReply(res));
      return;
    }
    if (!url.pathname.startsWith('/v1/')) return json(res, 404, error('not_found'));
    if (signIn(req, res, url)) return;
    // The dashboard is read only: the stub refuses every other method (the test counts them).
    if (req.method !== 'GET') return json(res, 405, error('method_not_allowed'));
    if (!authenticate(req, res)) return;
    const answer = fixtures(url);
    return answer
      ? json(res, answer.status ?? 200, answer.body)
      : json(res, 404, error('not_found'));
  })
  .listen(port, '127.0.0.1');
