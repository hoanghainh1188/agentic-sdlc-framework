// `pnpm eval:report` and `pnpm eval:pairs` (task L02, design/ADR-M78 §2.5, §2.6). Developer
// machines only. `report` reads the run results and the pairwise choices of a task set version
// and writes `report.md`, `report.json` and `pareto.svg` next to them. `pairs` shows two
// configurations' diffs of the same task and run as A and B in a random order and records the
// reviewer's choice. `purge-diffs` deletes the kept diffs. Texts come from the message catalog.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { t } from '@sdlc/messages';

import {
  appendChoice,
  asPairChoices,
  pendingPairs,
  purgeDiffs,
  readChoices,
  readDiff,
} from './pairs.js';
import { buildReport, renderMarkdown, renderParetoSvg } from './report.js';
import { readRunResults } from './result.js';

const write = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const fail = (text: string): number => {
  process.stderr.write(`${text}\n`);
  return 2;
};

function outFolder(value: string | undefined): string | null {
  if (!value || !path.isAbsolute(value) || !fs.existsSync(value)) return null;
  return value;
}

function report(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { out: { type: 'string' }, 'task-set': { type: 'string' }, json: { type: 'boolean' } },
  });
  const out = outFolder(values.out);
  if (!out) return fail(t('eval.cli.usage'));
  const taskSet = Number(values['task-set'] ?? '1');
  const results = readRunResults(out, taskSet);
  if (results.length === 0) return fail(t('eval.cli.no_results', { version: taskSet }));
  const built = buildReport(results, taskSet, asPairChoices(readChoices(out, taskSet)));
  fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(built, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'report.md'), renderMarkdown(built));
  fs.writeFileSync(path.join(out, 'pareto.svg'), renderParetoSvg(built));
  if (values.json) write(JSON.stringify(built, null, 2));
  else {
    write(renderMarkdown(built));
    write(t('eval.cli.written', { folder: out }));
  }
  return 0;
}

async function pairs(args: string[]): Promise<number> {
  if (args[0] === 'purge-diffs') return purge(args.slice(1));
  const { values } = parseArgs({
    args,
    options: {
      out: { type: 'string' },
      a: { type: 'string' },
      b: { type: 'string' },
      'task-set': { type: 'string' },
    },
  });
  const out = outFolder(values.out);
  if (!out || !values.a || !values.b || values.a === values.b) return fail(t('eval.cli.usage'));
  const taskSet = Number(values['task-set'] ?? '1');
  const pending = pendingPairs(out, taskSet, values.a, values.b);
  if (pending.length === 0) {
    write(t('eval.cli.pairs_none'));
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [i, pair] of pending.entries()) {
      // A random order per pair: the reviewer never knows which configuration is A.
      const swap = crypto.randomInt(2) === 1;
      const [left, right] = swap ? [values.b, values.a] : [values.a, values.b];
      const key = (configuration: string) => ({
        taskSet,
        configuration,
        task: pair.task,
        run: pair.run,
      });
      write(
        t('eval.cli.pair_header', {
          n: i + 1,
          total: pending.length,
          task: pair.task,
          run: pair.run,
        }),
      );
      write(`\n===== A =====\n${readDiff(out, key(left)) ?? ''}`);
      write(`\n===== B =====\n${readDiff(out, key(right)) ?? ''}`);
      let answer = '';
      while (!['a', 'b', 't', 's', 'q'].includes(answer)) {
        answer = (await rl.question(t('eval.cli.pair_prompt'))).trim().toLowerCase();
      }
      if (answer === 'q') break;
      if (answer === 's') continue;
      const winner = answer === 't' ? 'tie' : (answer === 'a') !== swap ? 'a' : 'b';
      appendChoice(out, taskSet, {
        schema: 1,
        task: pair.task,
        run: pair.run,
        a: values.a,
        b: values.b,
        winner,
      });
    }
  } finally {
    rl.close();
  }
  return 0;
}

function purge(args: string[]): number {
  const { values } = parseArgs({ args, options: { out: { type: 'string' } } });
  const out = outFolder(values.out);
  if (!out) return fail(t('eval.cli.usage'));
  write(t('eval.cli.purged', { count: purgeDiffs(out) }));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'report') return report(rest);
    if (command === 'pairs') return await pairs(rest);
    if (command === 'purge-diffs') return purge(rest);
  } catch (error) {
    return fail(t('eval.cli.failed', { reason: error instanceof Error ? error.name : 'error' }));
  }
  return fail(t('eval.cli.usage'));
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
