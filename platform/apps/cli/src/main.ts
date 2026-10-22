#!/usr/bin/env node
// Entry point of the `sdlc` command (bin). Logic lives in index.ts, so tests can run it.
import { t } from '@sdlc/messages';

import { renderBanner } from './banner.js';
import { EXIT, processContext, runCli } from './index.js';
import { clean } from './output.js';

const argv = process.argv.slice(2);
// Display ASCII banner when executed interactively without arguments or with help flag
if (
  process.stdout.isTTY &&
  (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h')
) {
  process.stdout.write(`${renderBanner(process.env)}\n\n`);
}

runCli(argv, processContext()).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${t('cli.failed', { reason: clean(error instanceof Error ? error.message : String(error)) })}\n`,
    );
    process.exitCode = EXIT.error;
  },
);
