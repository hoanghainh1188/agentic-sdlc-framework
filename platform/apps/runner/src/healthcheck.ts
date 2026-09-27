// Container health check (docker-compose.yml, service sdlc-runner): exit 0 when the heartbeat file
// is younger than two sweep intervals plus a margin. The runner writes it after the clean-up at
// start and after every sweep (main.ts), so a stuck process or an unreachable Docker turns it red.
import fs from 'node:fs';

import { processSettingsFromEnv } from './process.js';
import { runnerSettingsFromEnv } from './settings.js';

try {
  const { heartbeatFile } = processSettingsFromEnv(process.env);
  const { sweepIntervalMs } = runnerSettingsFromEnv(process.env);
  const age = Date.now() - fs.statSync(heartbeatFile).mtimeMs;
  process.exit(age <= 2 * sweepIntervalMs + 30_000 ? 0 : 1);
} catch {
  process.exit(1);
}
