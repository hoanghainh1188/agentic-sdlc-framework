// Scoring an evaluation run on the server against the in-process Docker stub (task L04, design/
// ADR-M81 §2.5, QUESTIONS #463): two containers over one volume (install with the package proxy;
// then the agent's diff and the hidden tests with no network), the proxy detached in between, the
// result read from the script's last line, and every Docker object removed at the end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DockerClient,
  RunnerError,
  scoreEvaluationRun,
  ScoringError,
  type ScoreEvaluationInput,
} from '../../apps/runner/src/index.js';
import { IMAGE, RUN_ID, settings, TENANT_ID } from './helpers';
import { StubDocker } from './stub-docker';

const s = settings();
const GOOD = '{"applied":true,"ci":true,"pass_to_pass":true,"fail_to_pass":true,"lint":2}';
const dirs: string[] = [];

function input(over: Partial<ScoreEvaluationInput> = {}): ScoreEvaluationInput {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-score-test-'));
  dirs.push(root);
  const tree = path.join(root, 'tree');
  const hidden = path.join(root, 'hidden');
  fs.mkdirSync(path.join(tree, 'apps/api'), { recursive: true });
  fs.mkdirSync(path.join(hidden, 'apps/api'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'package.json'), '{"name":"pilot"}\n');
  fs.writeFileSync(path.join(tree, 'apps/api/tax.ts'), 'export const tax = 1;\n');
  fs.writeFileSync(path.join(hidden, 'apps/api/tax.hidden.test.ts'), 'test("x", () => {});\n');
  return {
    runId: RUN_ID,
    tenantId: TENANT_ID,
    image: IMAGE,
    treeDir: tree,
    hiddenDir: hidden,
    basePatch: 'BASE-PATCH',
    agentPatch: 'AGENT-PATCH',
    task: { ci: ['pnpm lint'], passToPass: ['pnpm test'], failToPass: ['pnpm test hidden'] },
    ...over,
  };
}

describe('scoreEvaluationRun (stub Docker)', () => {
  let stub: StubDocker;
  let docker: DockerClient;

  beforeAll(async () => {
    stub = await StubDocker.start();
    docker = new DockerClient({ socketPath: stub.socketPath, timeoutMs: 5000 });
  });
  afterAll(() => stub.stop());
  beforeEach(() => {
    stub.calls.length = 0;
    stub.failures.clear();
    stub.containers.clear();
    stub.networks.clear();
    stub.volumes.clear();
    stub.images.clear();
    stub.exitCodes.length = 0;
    stub.stdout.clear();
    stub.stdout.set(`sdlc-sandbox-${RUN_ID}`, `${GOOD}\n`);
  });
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const empty = () =>
    expect([stub.containers.size, stub.networks.size, stub.volumes.size]).toEqual([0, 0, 0]);
  const deps = () => ({ docker, settings: s, installTimeoutMs: 5000, scoreTimeoutMs: 5000 });
  const at = (pattern: RegExp, from = 0) =>
    stub.trace.findIndex((line, i) => i >= from && pattern.test(line));

  it('installs with the proxy, detaches it, then scores with no network, and returns the result', async () => {
    const score = await scoreEvaluationRun(deps(), input());
    expect(score).toEqual({
      applied: true,
      ci: true,
      passToPass: true,
      failToPass: true,
      lintFindings: 2,
    });

    const create1 = at(/^POST \/containers\/create$/);
    const create2 = at(/^POST \/containers\/create$/, create1 + 1);
    const wait1 = at(/\/wait$/);
    const connect = at(/\/connect$/);
    const disconnect = at(/\/disconnect$/);
    const netDelete = at(/^DELETE \/networks\//, disconnect);
    const logs = at(/\/logs$/);
    expect(connect).toBeGreaterThan(-1);
    // Order: proxy attached → install container → … → proxy detached → network removed → score.
    expect(connect).toBeLessThan(create1);
    expect(wait1).toBeGreaterThan(create1);
    expect(disconnect).toBeGreaterThan(wait1);
    expect(netDelete).toBeGreaterThan(disconnect);
    expect(create2).toBeGreaterThan(netDelete);
    expect(logs).toBeGreaterThan(create2);

    const creates = stub.calls.filter(
      (c) => c.method === 'POST' && c.path === '/containers/create',
    );
    expect(creates).toHaveLength(2);
    const [install, run] = creates.map((c) => c.body as Record<string, unknown>) as [
      { HostConfig: { NetworkMode: string }; Cmd: string[]; Env: string[] },
      { HostConfig: { NetworkMode: string }; Cmd: string[]; Env: string[] },
    ];
    expect(install.HostConfig.NetworkMode).toBe(`sdlc-run-${RUN_ID}`);
    expect(install.Cmd).toEqual(['sh /workspace/in/install.sh']);
    expect(run.HostConfig.NetworkMode).toBe('none');
    expect(run.Cmd).toEqual(['sh /workspace/in/score.sh']);
    expect(run.Env.join(' ')).not.toContain('REGISTRY');
    empty();
  });

  it('puts the tree, the patches, the scripts and the hidden tests into the volume before install', async () => {
    await scoreEvaluationRun(deps(), input());
    const put = stub.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/archive'));
    expect(put?.query.path).toBe('/workspace');
    const tar = (put!.body as Buffer).toString('latin1');
    for (const name of [
      'work/package.json',
      'work/apps/api/tax.ts',
      'in/base.patch',
      'in/agent.patch',
      'in/install.sh',
      'in/score.sh',
      'in/hidden/apps/api/tax.hidden.test.ts',
      'BASE-PATCH',
      'AGENT-PATCH',
      'pnpm install --frozen-lockfile',
    ]) {
      expect(tar, name).toContain(name);
    }
    // Only the install container gets the archive; the score step finds it all in the volume.
    expect(stub.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('reads the last line of the output, so a line printed before it cannot decide', async () => {
    const forged = '{"applied":true,"ci":true,"pass_to_pass":true,"fail_to_pass":true,"lint":0}';
    stub.stdout.set(
      `sdlc-sandbox-${RUN_ID}`,
      `${forged}\n{"applied":true,"ci":true,"pass_to_pass":true,"fail_to_pass":false,"lint":0}\n`,
    );
    expect((await scoreEvaluationRun(deps(), input())).failToPass).toBe(false);
  });

  it('counts an output that is not a result as "not applied", and still removes everything', async () => {
    stub.stdout.set(`sdlc-sandbox-${RUN_ID}`, 'killed\n');
    expect(await scoreEvaluationRun(deps(), input())).toEqual({
      applied: false,
      ci: false,
      passToPass: false,
      failToPass: false,
      lintFindings: 0,
    });
    empty();
  });

  it('counts a score step that times out as "not applied", kills it and removes everything', async () => {
    stub.exitCodes.push(0, -1);
    expect(await scoreEvaluationRun(deps(), input())).toEqual({
      applied: false,
      ci: false,
      passToPass: false,
      failToPass: false,
      lintFindings: 0,
    });
    expect(at(/\/kill$/)).toBeGreaterThan(-1);
    empty();
  });

  it('fails when the packages cannot be installed: no score step, nothing left', async () => {
    stub.exitCodes.push(1);
    const error = await scoreEvaluationRun(deps(), input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScoringError);
    expect((error as ScoringError).reason).toBe('install_failed');
    expect(
      stub.calls.filter((c) => c.method === 'POST' && c.path === '/containers/create'),
    ).toHaveLength(1);
    empty();
  });

  it('fails with a timeout when the install step does not end, and kills its processes', async () => {
    stub.exitCodes.push(-1);
    const error = await scoreEvaluationRun(deps(), input()).catch((e: unknown) => e);
    expect((error as ScoringError).reason).toBe('install_timeout');
    expect(at(/\/kill$/)).toBeGreaterThan(-1);
    empty();
  });

  it('removes leftovers of an earlier attempt first, and pulls a missing image', async () => {
    stub.volumes.set(`sdlc-ws-${RUN_ID}`, {});
    await scoreEvaluationRun(deps(), input());
    expect(at(/^DELETE \/volumes\//)).toBeLessThan(at(/^POST \/volumes\/create$/));
    expect(at(/^POST \/images\/create$/)).toBeGreaterThan(-1);
    empty();
  });

  it('does nothing in Docker without a package proxy, and refuses a tree that is not clean', async () => {
    const noProxy = settings({ SDLC_RUNNER_NPM_REGISTRY: '' });
    await expect(scoreEvaluationRun({ docker, settings: noProxy }, input())).rejects.toMatchObject({
      reason: 'no_package_proxy',
    });
    expect(stub.calls).toHaveLength(0);

    const bad = input();
    fs.symlinkSync('/etc/passwd', path.join(bad.treeDir, 'link'));
    fs.writeFileSync(path.join(bad.treeDir, 'big'), 'x');
    // A symbolic link is kept as a link; a FIFO or a hard link is refused.
    fs.linkSync(path.join(bad.treeDir, 'big'), path.join(bad.treeDir, 'big2'));
    await expect(scoreEvaluationRun(deps(), bad)).rejects.toMatchObject({
      reason: 'workspace_invalid',
    });
    expect(stub.calls).toHaveLength(0);
  });

  it('turns a Docker failure into a code, never Docker text', async () => {
    stub.failures.set(/^POST \/networks\/create$/, 500);
    const error = await scoreEvaluationRun(deps(), input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerError);
    expect((error as ScoringError).reason).toBe('docker_error');
    expect((error as Error).message).not.toContain('secret-value');
    empty();
  });
});
