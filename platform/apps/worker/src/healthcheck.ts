// Container health check (docker-compose.yml, service sdlc-worker): exit 0 when the poller loop
// wrote its heartbeat file less than a minute ago.
import fs from 'node:fs';

const file = process.env.SDLC_WORKER_HEARTBEAT_FILE ?? '/tmp/sdlc-worker.heartbeat';
const MAX_AGE_MS = 60_000;

try {
  process.exit(Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS ? 0 : 1);
} catch {
  process.exit(1);
}
