// TCP relay for the C05 live test only. It stands in for the runner's own container: the runner
// code under test attaches it to the run's network (SDLC_RUNNER_SELF_CONTAINER), and the test
// process on the host reaches the Agent Server through its port published on 127.0.0.1. In
// Compose the runner itself joins the network, and no relay exists (ADR-M29).
import net from 'node:net';

const host = process.env.TARGET_HOST ?? '';
const port = Number(process.env.TARGET_PORT ?? '8000');
if (!/^sdlc-sandbox-[0-9a-f-]{36}$/.test(host)) throw new Error('TARGET_HOST must be a sandbox');

net
  .createServer((client) => {
    const upstream = net.connect(port, host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', close);
  })
  .listen(8000, '0.0.0.0');
