#!/usr/bin/env node
// `pnpm doctor [--env <file>] [--json]` (D-08 V07): checks a deployment on the machine of the
// stack and says what to fix. Read only (AC3): every command goes through the allowlist of
// `commands.ts`; it prints no secret and works on a stopped or sealed stack (it says so).
// The option is `--env`, not `--env-file`: Node.js reads `--env-file` itself, even after the
// script name, and would load every secret of the file into this process.
// Exit 0 when no check failed (warnings included), 1 when one did, 2 for a usage error (#404).
import path from 'node:path';
import { parseArgs } from 'node:util';

import { t } from '@sdlc/messages';

import { evaluate } from './checks/index.js';
import { createExec } from './exec.js';
import { deployPaths, gatherFacts } from './host.js';
import { renderJson, renderText } from './render.js';

const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
const repoRoot = path.resolve(import.meta.dirname, '../../../..');

async function main(argv: string[]): Promise<number> {
  let values: { env?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { env: { type: 'string' }, json: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write(`${t('doctor.usage')}\n`);
    return EXIT.usage;
  }
  const envFile = path.resolve(values.env ?? path.join(repoRoot, 'platform/deploy/.env'));
  const files = deployPaths(repoRoot);
  const exec = createExec({ bootstrap: files.bootstrap, images: files.images });
  const results = evaluate(await gatherFacts({ repoRoot, envFile }, exec));
  if (values.json === true) process.stdout.write(`${renderJson(results, envFile)}\n`);
  else process.stdout.write(`${renderText(results, envFile).join('\n')}\n`);
  return results.some((r) => r.status === 'failed') ? EXIT.failed : EXIT.ok;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write(`${t('doctor.failed')}\n`);
    process.exitCode = EXIT.failed;
  },
);
