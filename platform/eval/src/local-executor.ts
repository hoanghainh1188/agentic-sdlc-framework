// The executor of a developer machine (task L04, design/ADR-M81 §2.1, §2.5, QUESTIONS #463). It
// scores a run in a fresh container made from the project's sandbox image, with the Docker CLI:
//   1. an internal network (no way out) with the package proxy attached; the container installs the
//      packages from the base lockfile through the proxy;
//   2. the proxy is detached from the container;
//   3. the agent's diff and the hidden tests are applied and run with no egress.
// The container has no capability, runs as the sandbox user and has memory, CPU, process and time
// limits. It holds the same steps as the server's scoring, so both places score the same way.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { EvalExecutor, ScoringRequest } from './executor.js';
import { describeHardware, type ExecutionPlace, type HardwareInfo } from './hardware.js';
import { installScript, parseScore, SCORING_DIRS, scoringScript, type Score } from './scoring.js';

/** The sandbox user (runner `docker/guard.ts` SANDBOX_USER). */
const SANDBOX_USER = '10001:10001';
/** On the volume next to the repository, so pnpm can link packages from it. */
const PNPM_STORE = '/workspace/.pnpm-store';
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const SCORE_TIMEOUT_MS = 20 * 60_000;

/** The Docker CLI: arguments in, standard output out. Injected in unit tests. */
export type DockerCli = (
  args: readonly string[],
  options?: { readonly input?: Buffer | string; readonly timeoutMs?: number },
) => string;

export const dockerCli: DockerCli = (args, options) =>
  execFileSync('docker', [...args], {
    encoding: 'utf8',
    input: options?.input,
    timeout: options?.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();

export interface LocalExecutorOptions {
  /** The project's sandbox image, by tag or digest. */
  readonly image: string;
  /** A local clone of the repository that holds the pinned commit. */
  readonly cloneDir: string;
  readonly commit: string;
  /** The package proxy container (Verdaccio) and the address the scoring container uses. */
  readonly proxyContainer: string;
  readonly proxyUrl: string;
  /** The GPU name, when the evaluation measures one (`SDLC_EVAL_GPU` on the command line). */
  readonly gpu?: string | null;
  readonly docker?: DockerCli;
}

/** The arguments of `docker create` for a scoring container (exported for tests). */
export function scoringContainerArgs(input: {
  readonly name: string;
  readonly network: string;
  readonly image: string;
  readonly proxyUrl: string;
}): string[] {
  return [
    'create',
    '--name',
    input.name,
    '--network',
    input.network,
    '--user',
    SANDBOX_USER,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=1g,mode=1777',
    '--tmpfs',
    `/home/openhands:rw,size=512m,uid=10001,gid=10001`,
    '--pids-limit',
    '1024',
    '--memory',
    '6g',
    '--cpus',
    '4',
    // The volume keeps the repository, its packages and the pnpm store on one file system.
    '-v',
    '/workspace',
    '-e',
    'HOME=/home/openhands',
    '-e',
    `NPM_CONFIG_REGISTRY=${input.proxyUrl.replace(/\/?$/, '/')}`,
    '-e',
    `COREPACK_NPM_REGISTRY=${input.proxyUrl.replace(/\/$/, '')}`,
    '-e',
    `NPM_CONFIG_STORE_DIR=${PNPM_STORE}`,
    '--entrypoint',
    'sleep',
    input.image,
    'infinity',
  ];
}

export class LocalExecutor implements EvalExecutor {
  readonly where: ExecutionPlace = 'developer';
  private readonly docker: DockerCli;
  private hardwareInfo: HardwareInfo | undefined;

  constructor(private readonly options: LocalExecutorOptions) {
    this.docker = options.docker ?? dockerCli;
  }

  hardware(): Promise<HardwareInfo> {
    if (this.hardwareInfo === undefined) {
      let version = 'unknown';
      try {
        version = this.docker(['version', '--format', '{{.Server.Version}}']);
      } catch {
        // the Docker version stays unknown
      }
      this.hardwareInfo = describeHardware({
        dockerVersion: version,
        gpu: this.options.gpu ?? process.env.SDLC_EVAL_GPU ?? null,
      });
    }
    return Promise.resolve(this.hardwareInfo);
  }

  score(request: ScoringRequest): Promise<Score> {
    return Promise.resolve().then(() => this.scoreNow(request));
  }

  private scoreNow(request: ScoringRequest): Score {
    const id = crypto.randomBytes(6).toString('hex');
    const name = `sdlc-eval-score-${id}`;
    const network = `sdlc-eval-score-net-${id}`;
    const { docker, options } = { docker: this.docker, options: this.options };
    const quietly = (args: string[]): void => {
      try {
        docker(args);
      } catch {
        // already gone
      }
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-score-'));
    try {
      const inDir = path.join(dir, 'in');
      fs.mkdirSync(inDir);
      fs.writeFileSync(path.join(inDir, 'base.patch'), request.basePatch);
      fs.writeFileSync(path.join(inDir, 'agent.patch'), request.agentPatch);
      fs.writeFileSync(path.join(inDir, 'score.sh'), scoringScript(request.task));
      fs.cpSync(path.join(request.task.dir, 'hidden'), path.join(inDir, 'hidden'), {
        recursive: true,
      });

      // An internal network has no route out; only the proxy is on it, and only for step 1.
      docker(['network', 'create', '--internal', network]);
      docker(['network', 'connect', network, options.proxyContainer]);
      docker(
        scoringContainerArgs({ name, network, image: options.image, proxyUrl: options.proxyUrl }),
      );
      docker(['start', name]);
      const exec = (args: string[], extra?: { input?: Buffer | string; timeoutMs?: number }) =>
        docker(['exec', '-i', name, ...args], extra);
      exec(['mkdir', '-p', SCORING_DIRS.work, SCORING_DIRS.input, SCORING_DIRS.output]);
      // The pinned commit as a tar stream, and the inputs: no bind mount, no host path inside.
      const archive = execFileSync('git', ['archive', options.commit], {
        cwd: options.cloneDir,
        maxBuffer: 1024 * 1024 * 1024,
      });
      exec(['tar', '-xf', '-', '-C', SCORING_DIRS.work], { input: archive });
      exec(['tar', '-xf', '-', '-C', SCORING_DIRS.input], {
        input: execFileSync('tar', ['-cf', '-', '-C', inDir, '.'], {
          maxBuffer: 1024 * 1024 * 1024,
          env: { ...process.env, COPYFILE_DISABLE: '1' },
        }),
      });

      // Step 1: a clean install from the base lockfile, through the package proxy.
      try {
        exec(['sh', '-s'], { input: installScript(), timeoutMs: INSTALL_TIMEOUT_MS });
      } catch {
        throw new Error('scoring: the packages could not be installed');
      }
      // Step 2: the proxy leaves; the container now has no network at all.
      docker(['network', 'disconnect', network, options.proxyContainer]);
      docker(['network', 'disconnect', network, name]);

      // Step 3: the diff and the hidden tests, with no egress. A timeout or a failing script
      // leaves no score file, which counts as "not applied".
      try {
        exec(['sh', `${SCORING_DIRS.input}/score.sh`], { timeoutMs: SCORE_TIMEOUT_MS });
      } catch {
        // read what exists below
      }
      let text = '';
      try {
        text = exec(['cat', `${SCORING_DIRS.output}/score.json`]);
      } catch {
        return { applied: false, ci: false, passToPass: false, failToPass: false, lintFindings: 0 };
      }
      return parseScore(text);
    } finally {
      quietly(['rm', '-f', '-v', name]);
      quietly(['network', 'disconnect', '-f', network, options.proxyContainer]);
      quietly(['network', 'rm', network]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
