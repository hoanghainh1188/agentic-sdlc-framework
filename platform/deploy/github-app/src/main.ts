#!/usr/bin/env node
// `pnpm github-app:create --out <file outside the repo> [--org <org>] [--name <name>] [--force]`
// (D-08 V03). Run it yourself, in a terminal: never through a chat tool.
import path from 'node:path';

import { InputAbortedError, readHiddenLine } from '@sdlc/cli';
import { t } from '@sdlc/messages';

import { runCreate } from './run.js';

const here = import.meta.dirname;

const readPasted = async (signal: AbortSignal): Promise<string | undefined> => {
  if (!process.stdin.isTTY) return undefined;
  try {
    return await readHiddenLine(`${t('github_app.paste_prompt')} `, signal);
  } catch (error) {
    if (error instanceof InputAbortedError && signal.aborted) return undefined;
    throw error;
  }
};

process.exitCode = await runCreate(process.argv.slice(2), {
  repoRoot: path.resolve(here, '../../../..'),
  manifestFile: path.resolve(here, '../manifest.json'),
  githubUrl: 'https://github.com',
  apiUrl: 'https://api.github.com',
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readPasted,
});
// The hidden prompt may still hold standard input: end the process once the work is done.
process.exit();
