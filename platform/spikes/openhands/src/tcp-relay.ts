// TCP relay for the C01 spike: listens on 8000 and forwards to RELAY_TARGET (sandbox:8000).
// Runs in a `node:24` container that is on the default bridge (for the 127.0.0.1 port) and on the
// internal sandbox network. It lets the host-side PoC reach a sandbox that has no route out.
import { connect, createServer } from 'node:net';

const target = process.env['RELAY_TARGET'] ?? '';
const [host = '', portText = ''] = target.split(':');
const port = Number(portText);
if (!host || !Number.isInteger(port)) {
  console.error('RELAY_TARGET must be host:port');
  process.exit(1);
}

const server = createServer((client) => {
  const upstream = connect(port, host);
  client.pipe(upstream).pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
});

server.listen(8000, () => console.log(`relay 8000 -> ${host}:${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
