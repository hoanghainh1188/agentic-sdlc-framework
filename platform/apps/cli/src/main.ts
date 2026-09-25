#!/usr/bin/env node
// Entry point of the `sdlc` command (bin). Logic lives in index.ts, so tests can run it.
import { t } from '@sdlc/messages';

import { EXIT, processContext, runCli } from './index.js';

runCli(process.argv.slice(2), processContext()).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${t('cli.failed', { reason: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = EXIT.error;
  },
);
