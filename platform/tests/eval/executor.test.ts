// One evaluation engine for two places (task L04, design/ADR-M81 §2.1, §2.5): the hardware block,
// the run result both executors build, the report's "where it ran" section, and the local scoring
// steps (install through the proxy, detach the proxy, score with no egress) against a fake Docker.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildReport,
  buildRunResult,
  checkHardware,
  checkRunResult,
  cleanName,
  describeHardware,
  hardwareLabel,
  installScript,
  LocalExecutor,
  renderMarkdown,
  scoringContainerArgs,
  scoringScript,
  SCORING_DIRS,
  type DockerCli,
  type EvalTask,
  type RunResult,
} from '@sdlc/eval';

const HARDWARE = {
  cpu_model: 'Apple M4 Pro',
  cpu_cores: 12,
  memory_gb: 24,
  docker_version: '28.1.1',
  gpu: null,
  runner_instance: null,
};

const dirs: string[] = [];
const temp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-exec-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SCORE = { applied: true, ci: true, passToPass: true, failToPass: true, lintFindings: 0 };
const MEASURES = {
  outcome: 'finished',
  status: 'succeeded',
  stopReason: null,
  seconds: 90,
  iterations: 7,
  modelCalls: 7,
  inputTokens: 1000,
  outputTokens: 200,
  cachedInputTokens: 0,
  costUsd: '0.012300',
  outOfPlanFiles: 0,
};
const CONFIGURATION = { id: 'gpt-oss-20b', agentVersion: '1.0.0', model: { name: 'gpt-oss-20b' } };

/** A result as L02 wrote it: no `where`, no `hardware`. */
const beforeL04 = (r: RunResult): RunResult => {
  const copy: Record<string, unknown> = { ...r };
  delete copy.where;
  delete copy.hardware;
  return copy as unknown as RunResult;
};

const result = (over: Partial<Parameters<typeof buildRunResult>[0]> = {}): RunResult =>
  buildRunResult({
    taskSet: 1,
    task: { id: 'feat-tax' },
    configuration: CONFIGURATION,
    run: 1,
    instructionsSha256: 'a'.repeat(64),
    agentPatch: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n+one\n',
    score: SCORE,
    measures: MEASURES,
    where: 'developer',
    hardware: HARDWARE,
    ...over,
  });

describe('hardware block (ADR-M81 §2.1)', () => {
  it('accepts a described machine and labels it', () => {
    const h = describeHardware({ dockerVersion: '28.1.1' });
    expect(checkHardware(h)).toEqual(h);
    expect(h.runner_instance).toBeNull();
    expect(hardwareLabel(HARDWARE)).toBe('Apple M4 Pro, 12 cores, 24 GB');
  });

  it('keeps only allowed characters in a machine name', () => {
    expect(cleanName('Intel(R) Core(TM) i9 @ 2.3GHz\n<script>')).toBe(
      'Intel(R) Core(TM) i9 @ 2.3GHz script',
    );
    expect(cleanName('x'.repeat(300))).toHaveLength(128);
  });

  it.each([
    ['an undeclared field', { ...HARDWARE, hostname: 'laptop' }],
    ['a free-text model', { ...HARDWARE, cpu_model: 'a "quoted"\nname' }],
    ['a negative core count', { ...HARDWARE, cpu_cores: -1 }],
    ['a runner label with spaces', { ...HARDWARE, runner_instance: 'runner 1' }],
    ['not an object', 'laptop'],
  ])('refuses %s', (_name, value) => {
    expect(() => checkHardware(value)).toThrow(TypeError);
  });
});

describe('run results of both places (AC1)', () => {
  it('builds a checked result that says where it ran', () => {
    const r = result();
    expect(checkRunResult(r)).toEqual(r);
    expect(r).toMatchObject({ where: 'developer', hardware: HARDWARE, resolved: true });
    expect(r.diff_files).toBe(1);
    expect(r.diff_lines_added).toBe(1);
  });

  it('gives the server result the same shape with its own place and runner', () => {
    const server = result({
      where: 'server',
      hardware: { ...HARDWARE, runner_instance: 'runner-1' },
    });
    expect(Object.keys(server).sort()).toEqual(Object.keys(result()).sort());
    expect(checkRunResult(server).where).toBe('server');
  });

  it('keeps results made before the hardware block valid', () => {
    const old = beforeL04(result());
    expect(checkRunResult(old)).toEqual(old);
  });

  it('is not resolved when the change did not apply or a test group failed', () => {
    expect(result({ score: { ...SCORE, failToPass: false } }).resolved).toBe(false);
    expect(result({ score: { ...SCORE, applied: false } }).resolved).toBe(false);
  });

  it('counts files outside the plan as a scope breach, never naming them', () => {
    const r = result({ measures: { ...MEASURES, outOfPlanFiles: 2 } });
    expect(r.scope_breach).toBe(true);
    expect(r.out_of_plan_files).toBe(2);
  });

  it('refuses a bad place or an extra hardware field', () => {
    expect(() => checkRunResult({ ...result(), where: 'cloud' })).toThrow(/where/);
    expect(() => checkRunResult({ ...result(), hardware: { ...HARDWARE, hostname: 'x' } })).toThrow(
      /hardware/,
    );
  });

  it('puts the places and machines into the report', () => {
    const results = [
      result({ run: 1 }),
      result({ run: 2 }),
      result({
        run: 3,
        where: 'server',
        hardware: {
          ...HARDWARE,
          cpu_model: 'AMD EPYC 9354',
          gpu: 'NVIDIA L40S',
          runner_instance: 'runner-1',
        },
      }),
    ];
    const report = buildReport([...results, beforeL04(result({ run: 4 }))], 1);
    expect(report.environments.map((e) => [e.where, e.runs])).toEqual([
      ['developer', 2],
      ['server', 1],
      [null, 1],
    ]);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('Developer machine: Apple M4 Pro, 12 cores, 24 GB');
    expect(markdown).toContain('Server: AMD EPYC 9354');
    expect(markdown).toContain('GPU NVIDIA L40S');
    expect(markdown).toContain('Not recorded');
  });
});

describe('scoring steps (QUESTIONS #463)', () => {
  const task = {
    ci: ['pnpm lint'],
    passToPass: ['pnpm test'],
    failToPass: ['pnpm test hidden'],
  } as Pick<EvalTask, 'ci' | 'passToPass' | 'failToPass'>;

  it('installs from the base lockfile, frozen, before anything of the agent is in the container', () => {
    const script = installScript();
    expect(script).toContain('pnpm install --frozen-lockfile');
    // It waits for the package proxy first: a throw-away stack starts it just before scoring.
    expect(script.indexOf('-/ping')).toBeLessThan(script.indexOf('pnpm install'));
    expect(script).not.toContain('agent.patch');
    expect(script).not.toContain('hidden');
  });

  it('keeps every path of the scoring script inside the one volume', () => {
    const script = scoringScript(task);
    for (const dir of Object.values(SCORING_DIRS)) expect(dir.startsWith('/workspace/')).toBe(true);
    expect(script).toContain(`${SCORING_DIRS.input}/agent.patch`);
    expect(script).toContain(`${SCORING_DIRS.output}/score.json`);
    expect(script).not.toContain('/home/node');
  });

  it('creates the container as the sandbox user with no capability and read-only root', () => {
    const args = scoringContainerArgs({
      name: 'c1',
      network: 'n1',
      image: 'sandbox@sha256:abc',
      proxyUrl: 'http://npm:4873',
    });
    const pair = (flag: string, value: string) => args[args.indexOf(flag) + 1] === value;
    expect(pair('--user', '10001:10001')).toBe(true);
    expect(pair('--cap-drop', 'ALL')).toBe(true);
    expect(pair('--security-opt', 'no-new-privileges')).toBe(true);
    expect(pair('--network', 'n1')).toBe(true);
    expect(args).toContain('--read-only');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('--memory');
    expect(args).toContain('--cpus');
    expect(args).not.toContain('--privileged');
    expect(args.some((a) => a.includes('docker.sock'))).toBe(false);
    expect(args.some((a) => a.includes('/Users') || a.startsWith('/tmp:/'))).toBe(false);
    expect(args).toContain('NPM_CONFIG_REGISTRY=http://npm:4873/');
    expect(args.slice(-4)).toEqual(['--entrypoint', 'sleep', 'sandbox@sha256:abc', 'infinity']);
  });

  /** A repository with one commit and a task folder with a hidden file. */
  function fixture() {
    const root = temp();
    const clone = path.join(root, 'clone');
    fs.mkdirSync(clone);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
        cwd: clone,
      })
        .toString()
        .trim();
    git('init', '-q');
    fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const taskDir = path.join(root, 'task');
    fs.mkdirSync(path.join(taskDir, 'hidden'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'hidden', 'h.test.ts'), 'x\n');
    return { clone, commit: git('rev-parse', 'HEAD'), taskDir };
  }

  function executor(calls: string[][], failAt?: string): LocalExecutor {
    const { clone, commit } = fixture();
    const docker: DockerCli = (args) => {
      calls.push([...args]);
      const key = args.join(' ');
      if (failAt !== undefined && key.includes(failAt)) throw new Error('failed');
      if (args[0] === 'exec' && args.at(-1) === `${SCORING_DIRS.output}/score.json`) {
        return '{"applied":true,"ci":true,"pass_to_pass":true,"fail_to_pass":false,"lint":2}';
      }
      return '';
    };
    return new LocalExecutor({
      image: 'sandbox@sha256:abc',
      cloneDir: clone,
      commit,
      proxyContainer: 'npm-proxy',
      proxyUrl: 'http://npm-proxy:4873',
      docker,
    });
  }

  const request = () => {
    const { taskDir } = fixture();
    return {
      task: { ...task, dir: taskDir } as unknown as EvalTask,
      basePatch: 'base',
      agentPatch: 'agent',
    };
  };

  it('installs with the proxy, detaches it, and only then scores with no network', async () => {
    const calls: string[][] = [];
    const score = await executor(calls).score(request());
    expect(score).toEqual({
      applied: true,
      ci: true,
      passToPass: true,
      failToPass: false,
      lintFindings: 2,
    });
    const lines = calls.map((c) => c.join(' '));
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(lines[0]).toMatch(/^network create --internal sdlc-eval-score-net-/);
    expect(at('network connect')).toBeGreaterThan(-1);
    expect(at('create --name')).toBeGreaterThan(at('network connect'));
    const install = lines.findIndex((l) => l.startsWith('exec -i') && l.endsWith('sh -s'));
    const scoreRun = at(`sh ${SCORING_DIRS.input}/score.sh`);
    const detaches = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith('network disconnect ') && !l.includes(' -f '));
    expect(detaches).toHaveLength(2);
    expect(detaches[0]!.l).toMatch(/ npm-proxy$/);
    expect(detaches[1]!.l).toMatch(/ sdlc-eval-score-[0-9a-f]+$/);
    expect(install).toBeGreaterThan(-1);
    expect(detaches[0]!.i).toBeGreaterThan(install);
    expect(scoreRun).toBeGreaterThan(detaches[1]!.i);
    // The container, its volume and the network are removed at the end.
    expect(lines.some((l) => l.startsWith('rm -f -v sdlc-eval-score-'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^network rm sdlc-eval-score-net-/);
  });

  it('throws, and still cleans up, when the packages cannot be installed', async () => {
    const calls: string[][] = [];
    await expect(executor(calls, 'sh -s').score(request())).rejects.toThrow(/installed/);
    expect(calls.some((c) => c.join(' ').includes(`${SCORING_DIRS.input}/score.sh`))).toBe(false);
    expect(calls.at(-1)?.[0]).toBe('network');
    expect(calls.some((c) => c[0] === 'rm')).toBe(true);
  });

  it('counts a missing score file as not applied', async () => {
    const calls: string[][] = [];
    const score = await executor(calls, 'cat').score(request());
    expect(score).toEqual({
      applied: false,
      ci: false,
      passToPass: false,
      failToPass: false,
      lintFindings: 0,
    });
  });

  it('describes the hardware with the Docker version and an optional GPU', async () => {
    const calls: string[][] = [];
    const { clone, commit } = fixture();
    const local = new LocalExecutor({
      image: 'x',
      cloneDir: clone,
      commit,
      proxyContainer: 'p',
      proxyUrl: 'http://p:4873',
      gpu: 'NVIDIA L40S',
      docker: (args) => {
        calls.push([...args]);
        return '28.1.1';
      },
    });
    const h = await local.hardware();
    expect(h).toMatchObject({
      docker_version: '28.1.1',
      gpu: 'NVIDIA L40S',
      runner_instance: null,
    });
    expect(local.where).toBe('developer');
    await local.hardware();
    expect(calls).toHaveLength(1);
  });
});
