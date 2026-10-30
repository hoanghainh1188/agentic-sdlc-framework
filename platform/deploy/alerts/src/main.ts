#!/usr/bin/env node
// `pnpm alerts [--env <file>] [--dry-run | --test]` (D-08 O03, design/ADR-M101): runs the checks of
// `pnpm doctor` on the machine of the stack and sends what changed to the operator's webhook or
// e-mail. The schedule is the server's (a systemd timer or cron), never the platform's. The option
// is `--env`, not `--env-file`: Node.js would read `--env-file` itself and load every secret.
import os from 'node:os';
import path from 'node:path';

import { t } from '@sdlc/messages';

import { evaluate } from '../../doctor/dist/checks/index.js';
import { createExec } from '../../doctor/dist/exec.js';
import { deployPaths, gatherFacts } from '../../doctor/dist/host.js';

import { httpsPost } from './channels.js';
import { EXIT, runAlerts } from './run.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

/** `--env <file>` is taken here; the other options go to `runAlerts`. */
function split(argv: readonly string[]): { envFile: string; rest: string[] } {
  const rest = [...argv];
  const at = rest.indexOf('--env');
  let envFile = path.join(repoRoot, 'platform/deploy/.env');
  if (at >= 0 && rest[at + 1] !== undefined) {
    envFile = path.resolve(rest[at + 1]!);
    rest.splice(at, 2);
  }
  return { envFile, rest };
}

async function main(argv: readonly string[]): Promise<number> {
  const { envFile, rest } = split(argv);
  const files = deployPaths(repoRoot);
  const exec = createExec({ bootstrap: files.bootstrap, images: files.images });
  return runAlerts(rest, {
    envFile,
    now: () => new Date(),
    hostname: os.hostname(),
    results: async () => evaluate(await gatherFacts({ repoRoot, envFile }, exec)),
    post: httpsPost,
    out: (line) => process.stdout.write(`${line}\n`),
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write(`${t('alerts.failed')}\n`);
    process.exitCode = EXIT.failed;
  },
);
