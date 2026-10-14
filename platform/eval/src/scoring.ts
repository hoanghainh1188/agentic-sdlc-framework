// Scoring an evaluation run (task L02, design/ADR-M78 §2.3, the SWE-bench model; the three steps
// of task L04, design/ADR-M81 §2.5, QUESTIONS #463). The scoring container is the project's
// sandbox image on its own internal network and runs code the agent wrote:
//   1. a clean install from the base lockfile, through the package proxy (`installScript`);
//   2. the proxy is detached from the container;
//   3. the agent's diff and the hidden tests are applied and run with no egress (`scoringScript`):
//      the repository's checks (CI on the first try), the `pass_to_pass` commands, the hidden
//      files copied in, the `fail_to_pass` commands, and ESLint on the changed files.
// No capability, non-root, limits; it reports exit codes and a count only. The same steps run on a
// developer machine (`LocalExecutor`) and on the server (the runner, L04 PR 4).
import type { EvalTask } from './task.js';

/** Folders inside the scoring container, all under the volume `/workspace` (owned by the user). */
export const SCORING_DIRS = {
  /** The repository at the pinned commit, with its packages installed. */
  work: '/workspace/work',
  /** Inputs: `base.patch`, `agent.patch`, `score.sh`, `hidden/`. */
  input: '/workspace/in',
  /** Output: `score.json`. */
  output: '/workspace/out',
} as const;

export interface Score {
  readonly applied: boolean;
  readonly ci: boolean;
  readonly passToPass: boolean;
  readonly failToPass: boolean;
  readonly lintFindings: number;
}

/** A command of a task file, single-quoted for `sh` (the task loader refused shell syntax). */
function quoted(command: string): string {
  if (command.includes("'")) throw new Error('scoring: a command holds a quote');
  return `'${command}'`;
}

/**
 * Step 1: the script that installs the packages from the base lockfile. It runs while the package
 * proxy is reachable, before the agent's diff or any hidden file is in the container.
 */
export function installScript(): string {
  return [
    'set -eu',
    // The proxy may still be starting (a throw-away stack): wait until it answers, at most a minute.
    'tries=0',
    `until node -e "fetch(process.env.NPM_CONFIG_REGISTRY + '-/ping').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; do`,
    '  tries=$((tries + 1))',
    '  [ "$tries" -lt 60 ] || exit 1',
    '  sleep 1',
    'done',
    `cd ${SCORING_DIRS.work}`,
    'git init -q',
    'git add -A',
    'git -c user.name=eval -c user.email=eval@eval.invalid commit -qm pinned',
    'corepack install',
    'pnpm install --frozen-lockfile',
    '',
  ].join('\n');
}

/** Step 3: the script the scoring container runs with no egress (exported for tests). */
export function scoringScript(task: Pick<EvalTask, 'ci' | 'passToPass' | 'failToPass'>): string {
  const group = (name: string, commands: readonly string[]) =>
    [
      `${name}=true`,
      ...commands.map((c) => `sh -c ${quoted(c)} >/dev/null 2>&1 || ${name}=false`),
    ].join('\n');
  return [
    'set -u',
    `cd ${SCORING_DIRS.work}`,
    `result() { printf '{"applied":%s,"ci":%s,"pass_to_pass":%s,"fail_to_pass":%s,"lint":%s}\\n' "$1" "$2" "$3" "$4" "$5" > ${SCORING_DIRS.output}/score.json; }`,
    `git apply --whitespace=nowarn ${SCORING_DIRS.input}/base.patch || { result false false false false 0; exit 0; }`,
    'git add -A && git -c user.name=eval -c user.email=eval@eval.invalid commit -qm base',
    `if [ -s ${SCORING_DIRS.input}/agent.patch ]; then git apply --whitespace=nowarn ${SCORING_DIRS.input}/agent.patch || { result false false false false 0; exit 0; }; fi`,
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
    `cp -R ${SCORING_DIRS.input}/hidden/. ${SCORING_DIRS.work}/`,
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
