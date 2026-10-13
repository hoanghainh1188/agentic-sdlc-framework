// Blind pairwise review (task L02, design/ADR-M78 §2.6, AC7, QUESTIONS #445). A reviewer sees the
// diffs of two configurations for the same task and run, as A and B in a random order, and picks
// one or a tie. The diffs are kept on the developer's machine only, in `<out>/diffs/` (folders 700,
// files 600, outside the repository), never in a report or a result; `purge-diffs` deletes them.
// The choices file holds codes only: the task, the run, the two configurations and the winner.
import fs from 'node:fs';
import path from 'node:path';

import type { PairChoice } from './stats.js';

export interface RunKey {
  readonly taskSet: number;
  readonly configuration: string;
  readonly task: string;
  readonly run: number;
}

export interface StoredChoice {
  readonly schema: 1;
  readonly task: string;
  readonly run: number;
  readonly a: string;
  readonly b: string;
  readonly winner: 'a' | 'b' | 'tie';
}

const CODE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const diffsDir = (out: string): string => path.join(out, 'diffs');

export function diffPath(out: string, key: RunKey): string {
  return path.join(
    diffsDir(out),
    `v${String(key.taskSet)}`,
    key.configuration,
    key.task,
    `run-${String(key.run)}.patch`,
  );
}

/** Keeps a run's diff for blind review: private folders and file, written atomically. */
export function writeDiff(out: string, key: RunKey, patch: string): void {
  const file = diffPath(out, key);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let dir = path.dirname(file); dir.startsWith(diffsDir(out)); dir = path.dirname(dir)) {
    fs.chmodSync(dir, 0o700);
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, patch, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readDiff(out: string, key: RunKey): string | null {
  const file = diffPath(out, key);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/** Deletes every kept diff. Returns how many files were removed. */
export function purgeDiffs(out: string): number {
  const dir = diffsDir(out);
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  const walk = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(folder, entry.name));
      else count += 1;
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return count;
}

export const choicesPath = (out: string, taskSet: number): string =>
  path.join(out, 'pairs', `v${String(taskSet)}.jsonl`);

function checkChoice(value: unknown): StoredChoice {
  const r = value as Record<string, unknown>;
  const ok =
    typeof r === 'object' &&
    r !== null &&
    Object.keys(r).sort().join(',') === 'a,b,run,schema,task,winner' &&
    r.schema === 1 &&
    typeof r.task === 'string' &&
    /^[a-z][a-z0-9-]{1,47}$/.test(r.task) &&
    typeof r.run === 'number' &&
    Number.isInteger(r.run) &&
    r.run >= 1 &&
    typeof r.a === 'string' &&
    CODE.test(r.a) &&
    typeof r.b === 'string' &&
    CODE.test(r.b) &&
    r.a !== r.b &&
    (r.winner === 'a' || r.winner === 'b' || r.winner === 'tie');
  if (!ok) throw new TypeError('pair choice: bad record');
  return r as unknown as StoredChoice;
}

/** Every recorded choice of a task set version, checked. */
export function readChoices(out: string, taskSet: number): StoredChoice[] {
  const file = choicesPath(out, taskSet);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => checkChoice(JSON.parse(line)));
}

export function appendChoice(out: string, taskSet: number, choice: StoredChoice): void {
  const checked = checkChoice(choice);
  const file = choicesPath(out, taskSet);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(checked)}\n`);
}

/** The choices as Bradley-Terry input. */
export const asPairChoices = (choices: readonly StoredChoice[]): PairChoice[] =>
  choices.map(({ a, b, winner }) => ({ a, b, winner }));

/**
 * The (task, run) pairs that both configurations have a diff for and that are not chosen yet,
 * sorted by task and run.
 */
export function pendingPairs(
  out: string,
  taskSet: number,
  a: string,
  b: string,
): { task: string; run: number }[] {
  const root = path.join(diffsDir(out), `v${String(taskSet)}`);
  const runsOf = (configuration: string): Set<string> => {
    const found = new Set<string>();
    const dir = path.join(root, configuration);
    if (!fs.existsSync(dir)) return found;
    for (const task of fs.readdirSync(dir)) {
      for (const file of fs.readdirSync(path.join(dir, task))) {
        const run = /^run-([0-9]+)\.patch$/.exec(file)?.[1];
        if (run) found.add(`${task}\u0000${run}`);
      }
    }
    return found;
  };
  const ofB = runsOf(b);
  const done = new Set(
    readChoices(out, taskSet)
      .filter((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a))
      .map((c) => `${c.task}\u0000${String(c.run)}`),
  );
  return [...runsOf(a)]
    .filter((k) => ofB.has(k) && !done.has(k))
    .map((k) => {
      const [task, run] = k.split('\u0000') as [string, string];
      return { task, run: Number(run) };
    })
    .sort((x, y) => x.task.localeCompare(y.task) || x.run - y.run);
}
