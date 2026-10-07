// A stub of the API for the dashboard's smoke test (U01 AC6, design/ADR-M54 §2.6). It serves the
// built dashboard through the api's own `registerDashboard` (the real file list and CSP) and
// answers the GET endpoints the dashboard reads with fixed, fictional data. Anything else: 405.
// Settings: SDLC_DASHBOARD_E2E_PORT, SDLC_DASHBOARD_E2E_TOKEN (made by the test at run time).
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
    // The dashboard is read only: the stub refuses every other method (the test counts them).
    if (req.method !== 'GET') return json(res, 405, error('method_not_allowed'));
    if (req.headers.authorization !== `Bearer ${token}`)
      return json(res, 401, error('unauthorized'));
    const answer = fixtures(url);
    return answer
      ? json(res, answer.status ?? 200, answer.body)
      : json(res, 404, error('not_found'));
  })
  .listen(port, '127.0.0.1');
