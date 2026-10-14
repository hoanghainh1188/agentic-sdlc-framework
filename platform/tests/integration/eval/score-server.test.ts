// Scoring on the server, live (task L04, design/ADR-M81 §2.5, QUESTIONS #463): `scoreEvaluationRun`
// of the runner against a real Docker Engine, the sandbox image and the package proxy (Verdaccio),
// on task set v1. `pnpm test:eval-score` (SDLC_EVAL_SCORE_TEST=1). Developer machines and the
// owner's checks; needs Docker and internet (the sample repository at its pinned commit, npm
// packages through Verdaccio, cached in the volume `sdlc-eval-npm-cache`). No secret.
//
// - The reference solution resolves the task, the untouched base does not, and the score equals
//   what `LocalExecutor` (the developer machine's scoring) gives for the same task: both places
//   score the same way (D-08 L04 AC1).
// - The step that runs the diff and the hidden tests has **no network**: a check that tries the
//   package proxy, the internet and a DNS name passes only when every connection fails.
// - Nothing is left behind: no container, network or volume of the runner instance.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DockerClient,
  runnerSettingsFromEnv,
  scoreEvaluationRun,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import {
  ensureClone,
  loadTaskSet,
  LocalExecutor,
  prepareBase,
  type EvalTask,
  type TaskSet,
} from '@sdlc/eval';
import { deployDir } from '../../deploy/compose';
import { docker, dockerSocket, quietly } from '../runner/live-helpers';
import { buildSandboxImage, VERDACCIO } from '../sandbox-image/helpers';
import { repoRoot } from '../../workspace/helpers';

const enabled = process.env.SDLC_EVAL_SCORE_TEST === '1';
const suffix = crypto.randomBytes(4).toString('hex');
const names = {
  net: `sdlc-score-platform-${suffix}`,
  npm: `sdlc-score-npm-${suffix}`,
  registry: `sdlc-score-registry-${suffix}`,
};
const INSTANCE = `score-${suffix}`;
const TENANT = '33333333-3333-4333-8333-333333333333';
const NPM_CACHE_VOLUME = 'sdlc-eval-npm-cache';
const CACHE = process.env.SDLC_EVAL_CACHE ?? path.join(os.homedir(), '.cache', 'sdlc-eval');

describe.skipIf(!enabled)('L04 PR 4b: scoring on the server, live', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-score-'));
  let set: TaskSet;
  let clone: string;
  let image: string;
  let client: DockerClient;
  let settings: RunnerSettings;
  let local: LocalExecutor;
  let tree: string;

  beforeAll(async () => {
    set = loadTaskSet(path.join(repoRoot(), 'platform/eval/tasks/v1'), ['feat-tax']);
    clone = ensureClone(CACHE, set);
    image = process.env.SDLC_SANDBOX_IMAGE || (await buildSandboxImage(names.registry));
    docker('network', 'create', names.net);
    docker('pull', '-q', VERDACCIO);
    docker(
      'run',
      '-d',
      '--name',
      names.npm,
      '--network',
      names.net,
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--cap-drop',
      'ALL',
      '-v',
      `${NPM_CACHE_VOLUME}:/verdaccio/storage`,
      '-v',
      `${path.join(deployDir, 'verdaccio/config.yaml')}:/verdaccio/conf/config.yaml:ro`,
      VERDACCIO,
    );
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_INSTANCE: INSTANCE,
      SDLC_RUNNER_EGRESS_SERVICES: `npm-proxy=${names.npm}:4873`,
      SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
      SDLC_RUNNER_WORK_DIR: path.join(tmp, 'work'),
    });
    client = new DockerClient({ socketPath: dockerSocket(), timeoutMs: 900_000 });
    local = new LocalExecutor({
      image,
      cloneDir: clone,
      commit: set.commit,
      proxyContainer: names.npm,
      proxyUrl: `http://${names.npm}:4873`,
    });
    // The pinned commit's tree as files, the way the evaluation puts it into the scoring volume.
    tree = path.join(tmp, 'tree');
    fs.mkdirSync(tree);
    const archive = execFileSync('git', ['archive', set.commit], {
      cwd: clone,
      maxBuffer: 1024 * 1024 * 1024,
    });
    execFileSync('tar', ['-x', '-C', tree], { input: archive });
  }, 3_600_000);

  afterAll(() => {
    quietly('rm', '-f', '-v', names.registry);
    quietly('rm', '-f', names.npm);
    quietly('network', 'rm', names.net);
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 300_000);

  const leftovers = (): string => {
    const filter = `label=sdlc.runner-instance=${INSTANCE}`;
    return [
      docker('ps', '-a', '-q', '--filter', filter),
      docker('network', 'ls', '-q', '--filter', filter),
      docker('volume', 'ls', '-q', '--filter', filter),
    ].join('');
  };

  const request = (task: EvalTask, agentPatch: string, runId: string) => {
    const base = prepareBase({
      clone,
      commit: set.commit,
      task,
      instructionsText: null,
      workDir: fs.mkdtempSync(path.join(tmp, `${task.id}-`)),
    });
    return {
      base,
      input: {
        runId,
        tenantId: TENANT,
        image,
        treeDir: tree,
        hiddenDir: path.join(task.dir, 'hidden'),
        basePatch: base.basePatch,
        agentPatch,
        task,
      },
    };
  };

  it(
    'resolves the task with the reference solution, not with the base, and equals the developer machine',
    { timeout: 3_600_000 },
    async () => {
      const task = set.tasks[0]!;
      expect(task.solutionPatch).not.toBeNull();
      const deps = { docker: client, settings };
      const solved = request(task, task.solutionPatch!, '11111111-1111-4111-8111-111111111111');
      const untouched = request(task, '', '22222222-2222-4222-8222-222222222222');

      const serverSolved = await scoreEvaluationRun(deps, solved.input);
      const serverUntouched = await scoreEvaluationRun(deps, untouched.input);
      expect(serverSolved).toMatchObject({
        applied: true,
        ci: true,
        passToPass: true,
        failToPass: true,
      });
      expect(serverUntouched).toMatchObject({ applied: true, failToPass: false });

      const localSolved = await local.score({
        task,
        basePatch: solved.base.basePatch,
        agentPatch: task.solutionPatch!,
      });
      const localUntouched = await local.score({
        task,
        basePatch: untouched.base.basePatch,
        agentPatch: '',
      });
      expect(serverSolved).toEqual(localSolved);
      expect(serverUntouched).toEqual(localUntouched);
      expect(leftovers()).toBe('');
    },
  );

  it(
    'runs the diff and the hidden tests with no network: the proxy, the internet and DNS all fail',
    { timeout: 3_600_000 },
    async () => {
      const task = set.tasks[0]!;
      // Positive control: with a network to the proxy, the same call succeeds, so the probe below
      // can tell a blocked connection from a broken command.
      expect(() =>
        docker(
          'run',
          '--rm',
          '--network',
          names.net,
          '--entrypoint',
          'node',
          image,
          '-e',
          `fetch("http://${names.npm}:4873/-/ping",{signal:AbortSignal.timeout(5000)}).then((r)=>process.exit(r.ok?0:2),()=>process.exit(3))`,
        ),
      ).not.toThrow();
      // A command passes (exit 0) only when the connection FAILS.
      // The scoring script refuses a single quote in a command, so the JavaScript uses double ones.
      const mustFail = (url: string) =>
        `node -e "fetch(\\"${url}\\",{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(1),()=>process.exit(0))"`;
      const probe: EvalTask = {
        ...task,
        ci: [
          mustFail(`http://${names.npm}:4873/-/ping`),
          mustFail('http://npm-proxy:4873/-/ping'),
          mustFail('http://1.1.1.1/'),
          mustFail('http://registry.npmjs.org/'),
        ],
        passToPass: [],
        failToPass: [],
      };
      const run = request(probe, '', '33333333-3333-4333-8333-333333333334');
      const score = await scoreEvaluationRun({ docker: client, settings }, run.input);
      expect(score.applied).toBe(true);
      expect(score.ci).toBe(true);
      expect(leftovers()).toBe('');
    },
  );

  it(
    'fails with a code, and leaves nothing, when the packages cannot be installed',
    { timeout: 600_000 },
    async () => {
      const task = set.tasks[0]!;
      const run = request(task, '', '44444444-4444-4444-8444-444444444444');
      // A lockfile the registry cannot satisfy.
      fs.writeFileSync(
        path.join(tree, 'pnpm-lock.yaml'),
        `${fs.readFileSync(path.join(tree, 'pnpm-lock.yaml'), 'utf8')}\nthis is not a lockfile: [\n`,
      );
      try {
        await expect(
          scoreEvaluationRun({ docker: client, settings }, run.input),
        ).rejects.toMatchObject({ reason: 'install_failed' });
      } finally {
        const archive = execFileSync('git', ['archive', set.commit, 'pnpm-lock.yaml'], {
          cwd: clone,
        });
        execFileSync('tar', ['-x', '-C', tree], { input: archive });
      }
      expect(leftovers()).toBe('');
    },
  );
});
