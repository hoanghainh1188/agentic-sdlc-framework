#!/usr/bin/env node
// Entry point of the `adlc` command (bin). Logic lives in index.ts, so tests can run it.
import { t } from '@sdlc/messages';

import { renderBanner } from './banner.js';
import { EXIT, processContext, runCli } from './index.js';
import { startedAsLegacyName } from './legacy-name.js';
import { clean } from './output.js';

const argv = process.argv.slice(2);
// ADR-M100 §2.2: the old name gets one note on stderr; stdout and the exit code stay the same.
if (startedAsLegacyName(process.argv[1])) process.stderr.write(`${t('cli.renamed')}\n`);
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
