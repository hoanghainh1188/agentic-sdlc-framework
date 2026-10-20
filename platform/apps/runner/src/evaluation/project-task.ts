// A project's evaluation task, read from the project's clone (task L07, design/ADR-M85 §2.5,
// §2.10). Used by the task check and by an evaluation run on the project's task set:
// - the card at a commit, with the SHA-256 the platform stored (else `card_changed`);
// - the spec at the card's spec commit, with the card's SHA-256 (else `spec_changed`);
// - the hidden tests at the merge commit, written under `<workDir>/hidden` (else
//   `hidden_test_missing`).
// Git runs hardened (`gitArgs`, `gitEnv`). Paths, the card, the spec and the tests never reach a
// log, an error or the returned codes.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseTaskCard, taskCardPath, taskOfCard, type EvalTask, type TaskCard } from '@sdlc/eval';

import { gitArgs, gitEnv } from '../workspace/proposal.js';

const run = promisify(execFile);

/** The largest card, spec or hidden test file read from Git. */
const MAX_FILE_BYTES = 1024 * 1024;

export type ProjectTaskFailure = 'card_changed' | 'spec_changed' | 'hidden_test_missing';

/** The task cannot be used as it is: a code only. */
export class ProjectTaskError extends Error {
  override readonly name = 'ProjectTaskError';
  constructor(readonly code: ProjectTaskFailure) {
    super(code);
  }
}

export interface ProjectTask {
  readonly card: TaskCard;
  readonly task: EvalTask;
  /** The hidden tests, at their paths in the repository. */
  readonly hiddenDir: string;
}

export const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A file of the repository at a commit, as bytes; undefined when it does not exist there. */
export async function fileAt(
  repo: string,
  home: string,
  commit: string,
  file: string,
  timeoutMs: number,
): Promise<Buffer | undefined> {
  try {
    const { stdout } = await run('git', gitArgs(repo, ['show', `${commit}:${file}`]), {
      env: gitEnv(home),
      timeout: timeoutMs,
      encoding: 'buffer',
      maxBuffer: MAX_FILE_BYTES,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** Reads and checks the task of a card at `cardCommit`. Throws `ProjectTaskError`. */
export async function readProjectTask(input: {
  readonly repo: string;
  readonly home: string;
  readonly taskId: string;
  readonly cardCommit: string;
  readonly cardSha256: string;
  readonly workDir: string;
  readonly timeoutMs: number;
}): Promise<ProjectTask> {
  const { repo, home, timeoutMs } = input;
  const cardBytes = await fileAt(
    repo,
    home,
    input.cardCommit,
    taskCardPath(input.taskId),
    timeoutMs,
  );
  if (!cardBytes || sha256(cardBytes) !== input.cardSha256) {
    throw new ProjectTaskError('card_changed');
  }
  let card: TaskCard;
  try {
    card = parseTaskCard(cardBytes.toString('utf8'), taskCardPath(input.taskId));
  } catch {
    throw new ProjectTaskError('card_changed');
  }
  if (card.id !== input.taskId) throw new ProjectTaskError('card_changed');
  const spec = await fileAt(repo, home, card.spec.commit, card.spec.path, timeoutMs);
  if (!spec || sha256(spec) !== card.spec.sha256) throw new ProjectTaskError('spec_changed');

  const hiddenDir = path.join(input.workDir, 'hidden');
  fs.mkdirSync(hiddenDir, { mode: 0o700 });
  for (const file of card.hiddenTests) {
    const bytes = await fileAt(repo, home, card.mergeCommit, file, timeoutMs);
    if (!bytes) throw new ProjectTaskError('hidden_test_missing');
    const target = path.resolve(hiddenDir, file);
    if (!target.startsWith(`${hiddenDir}${path.sep}`)) throw new ProjectTaskError('card_changed');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { mode: 0o600 });
  }
  return { card, task: taskOfCard(card, spec.toString('utf8')), hiddenDir };
}
