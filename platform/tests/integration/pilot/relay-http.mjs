// HTTP relay for the C09 pilot suite only. It stands in for the runner's own container
// (SDLC_RUNNER_SELF_CONTAINER): the runner code under test attaches it to each run's network, and
// the test process on the host reaches a run's Agent Server through one port on 127.0.0.1, at
// `/run/<run_id>/…` (the runner's `agentUrl` option). The C05 relay (`agent/relay.mjs`) serves one
// run; the pilot suite runs many through one runner. In Compose the runner joins the network itself.
import http from 'node:http';

const RUN = /^\/run\/([0-9a-f-]{36})(\/.*)$/;

http
  .createServer((req, res) => {
    const match = RUN.exec(req.url ?? '');
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const upstream = http.request(
      {
        host: `sdlc-sandbox-${match[1]}`,
        port: 8000,
        method: req.method,
        path: match[2],
        headers: { ...req.headers, host: `sdlc-sandbox-${match[1]}:8000` },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  })
  .listen(8000, '0.0.0.0');
