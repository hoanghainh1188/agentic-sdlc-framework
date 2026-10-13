// Scoring an evaluation run (task L02, design/ADR-M78 §2.3, the SWE-bench model). The agent's diff
// is applied on the base in a fresh container, then: the repository's checks (CI on the first try),
// the `pass_to_pass` commands, the hidden files copied in, the `fail_to_pass` commands, and ESLint
// on the changed files. The container runs code the agent wrote, so it has no network, no
// capability, a non-root user and limits; it reports exit codes and a count only.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { EvalTask } from './task.js';

export interface Score {
  readonly applied: boolean;
  readonly ci: boolean;
  readonly passToPass: boolean;
  readonly failToPass: boolean;
  readonly lintFindings: number;
}

/** node 24 on Alpine, pinned by digest (the image of the live agent tests). */
export const NODE_IMAGE =
  'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';

const SCORE_TIMEOUT_MS = 20 * 60_000;

/** A command of a task file, single-quoted for `sh` (the task loader refused shell syntax). */
function quoted(command: string): string {
  if (command.includes("'")) throw new Error('scoring: a command holds a quote');
  return `'${command}'`;
}

/** The script the scoring container runs (exported for tests). Exit codes and a count only. */
export function scoringScript(task: Pick<EvalTask, 'ci' | 'passToPass' | 'failToPass'>): string {
  const group = (name: string, commands: readonly string[]) =>
    [
      `${name}=true`,
      ...commands.map((c) => `sh -c ${quoted(c)} >/dev/null 2>&1 || ${name}=false`),
    ].join('\n');
  return [
    'set -u',
    'cd /home/node/work',
    'result() { printf \'{"applied":%s,"ci":%s,"pass_to_pass":%s,"fail_to_pass":%s,"lint":%s}\\n\' "$1" "$2" "$3" "$4" "$5" > /out/score.json; }',
    'git apply --whitespace=nowarn /in/base.patch || { result false false false false 0; exit 0; }',
    'git add -A && git -c user.name=eval -c user.email=eval@eval.invalid commit -qm base',
    'if [ -s /in/agent.patch ]; then git apply --whitespace=nowarn /in/agent.patch || { result false false false false 0; exit 0; }; fi',
    group('ci', task.ci),
    // Lint only the files the agent changed (added or modified TypeScript and Vue files).
    'lint=0',
    'files=$(git diff --name-only --diff-filter=AM HEAD -- "*.ts" "*.vue")',
    'git ls-files --others --exclude-standard -- "*.ts" "*.vue" > /tmp/new-files',
    'files="$files $(cat /tmp/new-files)"',
    'if [ -n "$(echo $files | tr -d " ")" ]; then',
    '  lint=$(pnpm exec eslint -f json $files 2>/dev/null | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).reduce((n,f)=>n+f.messages.length,0))}catch{console.log(0)}})\')',
    'fi',
    group('p2p', task.passToPass),
    'cp -R /in/hidden/. /home/node/work/',
    group('f2p', task.failToPass),
    'result true "$ci" "$p2p" "$f2p" "${lint:-0}"',
    '',
  ].join('\n');
}

/** Parses the container's `score.json` (exported for tests). */
export function parseScore(text: string): Score {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const bool = (key: string): boolean => {
    if (typeof raw[key] !== 'boolean') throw new TypeError(`score: bad ${key}`);
    return raw[key];
  };
  const lint = raw.lint;
  if (typeof lint !== 'number' || !Number.isSafeInteger(lint) || lint < 0) {
    throw new TypeError('score: bad lint');
  }
  return {
    applied: bool('applied'),
    ci: bool('ci'),
    passToPass: bool('pass_to_pass'),
    failToPass: bool('fail_to_pass'),
    lintFindings: lint,
  };
}

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/**
 * The base image of a task set: the pinned commit with its packages installed (needs network to
 * build, once). `repoDir` is a clone of the repository; the image holds no `.git` of it.
 */
export function ensureBaseImage(repoDir: string, commit: string): string {
  const tag = `sdlc-eval-base:${commit.slice(0, 12)}`;
  try {
    docker('image', 'inspect', tag);
    return tag;
  } catch {
    // not built yet
  }
  const context = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-base-'));
  try {
    execFileSync('git', ['archive', '-o', path.join(context, 'repo.tar'), commit], {
      cwd: repoDir,
    });
    fs.writeFileSync(
      path.join(context, 'Dockerfile'),
      [
        `FROM ${NODE_IMAGE}`,
        'RUN apk add --no-cache git && corepack enable',
        'ENV COREPACK_HOME=/home/node/.corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
        'USER node',
        'WORKDIR /home/node',
        'COPY --chown=node:node repo.tar /home/node/repo.tar',
        'RUN mkdir work && tar -xf repo.tar -C work && rm repo.tar && cd work && git init -q && git add -A && git -c user.name=eval -c user.email=eval@eval.invalid commit -qm pinned && corepack install && pnpm install --frozen-lockfile',
        '',
      ].join('\n'),
    );
    execFileSync('docker', ['build', '-q', '-t', tag, context], { stdio: 'ignore' });
    return tag;
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}

/** Scores one run in a fresh, isolated container. */
export function scoreRun(input: {
  readonly image: string;
  readonly task: EvalTask;
  readonly basePatch: string;
  readonly agentPatch: string;
}): Score {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-score-'));
  try {
    const inDir = path.join(dir, 'in');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(inDir);
    fs.mkdirSync(outDir, { mode: 0o777 });
    fs.chmodSync(outDir, 0o777);
    fs.writeFileSync(path.join(inDir, 'base.patch'), input.basePatch);
    fs.writeFileSync(path.join(inDir, 'agent.patch'), input.agentPatch);
    fs.writeFileSync(path.join(inDir, 'score.sh'), scoringScript(input.task));
    fs.cpSync(path.join(input.task.dir, 'hidden'), path.join(inDir, 'hidden'), { recursive: true });
    const name = `sdlc-eval-score-${crypto.randomBytes(6).toString('hex')}`;
    try {
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          'none',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '1024',
          '--memory',
          '6g',
          '--cpus',
          '4',
          '-v',
          `${inDir}:/in:ro`,
          '-v',
          `${outDir}:/out`,
          input.image,
          'sh',
          '/in/score.sh',
        ],
        { stdio: 'ignore', timeout: SCORE_TIMEOUT_MS },
      );
    } catch {
      // A timeout or a failed container: remove it; the score below is "not resolved".
      try {
        docker('rm', '-f', name);
      } catch {
        // already gone
      }
    }
    const file = path.join(outDir, 'score.json');
    if (!fs.existsSync(file)) {
      return { applied: false, ci: false, passToPass: false, failToPass: false, lintFindings: 0 };
    }
    return parseScore(fs.readFileSync(file, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
