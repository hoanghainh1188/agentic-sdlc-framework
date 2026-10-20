// D-08 L07 PR 4b on PostgreSQL with the Docker stub and a real Git repository (design/ADR-M85 §2.5,
// QUESTIONS #488, #489): the runner's check of a project's task (AC3).
// - the signed contract is verified; the repository is cloned at the base commit and the token is
//   revoked; the card and the spec are read from Git and their SHA-256 checked; the hidden tests
//   come from the merge commit; the solution is the diff from base to merge without the tests;
// - two scorings: the base without a change (the hidden tests must fail), then with the solution;
// - codes: `checked`, `passes_without_change`, `solution_fails`, `install_failed`,
//   `card_changed`, `spec_changed`; a refused contract and a Docker path through the stub;
// - nothing is left on disk.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  CheckEvaluationTaskInput,
  RunContractSigner,
  RunContractVerifier,
} from '@sdlc/contracts';
import { renderTaskCard, type Score, type TaskCard } from '@sdlc/eval';
import { Redacted } from '@sdlc/secrets';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  checkTask,
  DockerClient,
  HeldRuns,
  runnerSettingsFromEnv,
  ScoringError,
  SlotPool,
  type CheckTaskDeps,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import type { ScoreEvaluationInput } from '../../../apps/runner/src/evaluation/score.js';
import { prepareTaskCheck } from '../../../packages/core/src/evaluation/index.js';
import { StubDocker } from '../../runner/stub-docker.js';
import { seedTaskWorld, TASK_NOW } from '../task-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const TOKEN = 'ghs_checkCloneTokenCanary000000000';
const PASS: Score = {
  applied: true,
  ci: true,
  passToPass: true,
  failToPass: true,
  lintFindings: 0,
};
const BASE_FAILS: Score = { ...PASS, failToPass: false };
const CARD_PATH = '.sdlc/eval-tasks/tax-rule.yaml';
const SPEC = '# Tax\n\nAC1: the tax is 10%.\n';

class FakeTransit implements RunContractSigner, RunContractVerifier {
  readonly signed = new Map<string, string>();
  sign(bytes: Uint8Array) {
    const signature = `vault:v1:${crypto.randomBytes(48).toString('base64')}`;
    this.signed.set(Buffer.from(bytes).toString('hex'), signature);
    return Promise.resolve({ signature, keyVersion: 1 });
  }
  publicKey() {
    return Promise.reject(new Error('not used'));
  }
  verify(bytes: Uint8Array, signature: string) {
    return Promise.resolve(this.signed.get(Buffer.from(bytes).toString('hex')) === signature);
  }
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

interface Source {
  readonly dir: string;
  readonly base: string;
  readonly merge: string;
  /** Commit with a good card, and one whose card names a spec hash Git does not have. */
  readonly cardCommit: string;
  readonly card: string;
  readonly badSpecCommit: string;
  readonly badSpecCard: string;
}

describeDb('L07 PR 4b: the runner checks a project task (stub Docker, real Git)', () => {
  let t: TestDatabase;
  let docker: StubDocker;
  let client: DockerClient;
  let settings: RunnerSettings;
  let tmp: string;
  let src: Source;
  let tenants = 0;
  let revoked: string[] = [];
  let scored: { input: ScoreEvaluationInput; hidden: string[]; base: string }[] = [];
  const transit = new FakeTransit();

  function makeSource(): Source {
    const dir = path.join(tmp, 'source');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    };
    fs.mkdirSync(dir, { recursive: true });
    git('init', '-q', '-b', 'main');
    write('package.json', '{"name":"shop"}\n');
    write('src/tax.ts', 'export const tax = 0;\n');
    write('docs/specs/tax.md', SPEC);
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    write('src/tax.ts', 'export const tax = 0.1;\n');
    write('src/tax.spec.ts', 'expect(tax).toBe(0.1);\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'merge');
    const merge = git('rev-parse', 'HEAD');
    const cardOf = (specSha: string): string => {
      const card: TaskCard = {
        id: 'tax-rule',
        intent: 'INT-2026-0001',
        baseCommit: base,
        mergeCommit: merge,
        spec: { path: 'docs/specs/tax.md', commit: base, sha256: specSha },
        hiddenTests: ['src/tax.spec.ts'],
        plannedFiles: ['src/tax.ts'],
        failToPass: ['pnpm test -- src/tax.spec.ts'],
        passToPass: ['pnpm test'],
        ci: ['pnpm lint'],
      };
      return renderTaskCard(card);
    };
    const card = cardOf(sha256(SPEC));
    write(CARD_PATH, card);
    git('add', '-A');
    git('commit', '-q', '-m', 'card');
    const cardCommit = git('rev-parse', 'HEAD');
    const badSpecCard = cardOf('f'.repeat(64));
    write(CARD_PATH, badSpecCard);
    git('add', '-A');
    git('commit', '-q', '-m', 'card with a wrong spec hash');
    return {
      dir,
      base,
      merge,
      cardCommit,
      card,
      badSpecCommit: git('rev-parse', 'HEAD'),
      badSpecCard,
    };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    docker = await StubDocker.start();
    client = new DockerClient({ socketPath: docker.socketPath, timeoutMs: 5000 });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-task-check-'));
    src = makeSource();
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_INSTANCE: 'sdlc',
      SDLC_RUNNER_EGRESS_SERVICES: 'litellm=sdlc-litellm-1:4000,npm-proxy=sdlc-npm-proxy-1:4873',
      SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
      SDLC_RUNNER_SELF_CONTAINER: 'sdlc-runner-1',
      SDLC_RUNNER_WORK_DIR: path.join(tmp, 'work'),
    });
  }, 60_000);
  afterAll(async () => {
    await docker?.stop();
    await t?.drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    docker.calls.length = 0;
    docker.containers.clear();
    docker.networks.clear();
    docker.volumes.clear();
    docker.exitCodes.length = 0;
    docker.stdout.clear();
    revoked = [];
    scored = [];
  });
  afterEach(() => {
    expect(fs.existsSync(settings.workDir) ? fs.readdirSync(settings.workDir) : []).toEqual([]);
  });

  /** A registered task whose card (as the Git host shows it) is `cardText` at `cardCommit`. */
  async function handedOver(
    cardCommit = src.cardCommit,
    cardText = src.card,
  ): Promise<CheckEvaluationTaskInput> {
    const w = await seedTaskWorld(t.app, `runner-check-${String(++tenants)}`);
    const { task } = await w.scope.evaluationTasks.register({
      projectId: w.projectId,
      taskId: 'tax-rule',
      intentId: w.intentId,
      cardCommit,
      cardSha256: sha256(cardText),
      baseCommit: src.base,
      mergeCommit: src.merge,
      registeredBy: null,
    });
    const prepared = await prepareTaskCheck(
      w.scope,
      {
        signer: transit,
        gitHost: {
          getBranchHead: () => Promise.resolve(cardCommit),
          getFileAtCommit: () => Promise.resolve(cardText),
          issueShortLivedToken: () =>
            Promise.resolve({
              token: new Redacted(TOKEN),
              expiresAt: TASK_NOW,
            } as unknown as Awaited<
              ReturnType<Parameters<typeof prepareTaskCheck>[1]['gitHost']['issueShortLivedToken']>
            >),
        },
        wrapper: { wrap: () => Promise.resolve(new Redacted('wrap-git')) },
        now: () => TASK_NOW,
      },
      task.id,
    );
    if (!prepared.ok) throw new Error(`not prepared: ${prepared.reason}`);
    return prepared.input;
  }

  /** A scorer that answers `results` in order and records what it was given. */
  const scorer =
    (...results: (Score | Error)[]): NonNullable<CheckTaskDeps['score']> =>
    (_deps, input) => {
      const files: string[] = [];
      const walk = (dir: string, prefix = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
          else files.push(rel);
        }
      };
      walk(input.hiddenDir);
      scored.push({ input, hidden: files, base: input.basePatch });
      const next = results[scored.length - 1]!;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };

  function deps(over: Partial<CheckTaskDeps> = {}): CheckTaskDeps {
    return {
      db: t.app as unknown as CheckTaskDeps['db'],
      docker: client,
      settings,
      verifier: transit,
      unwrapper: {
        unwrap: (wrapped) =>
          Promise.resolve<Record<string, Redacted>>(
            wrapped.reveal() === 'wrap-git' ? { token: new Redacted(TOKEN) } : {},
          ),
      },
      pool: new SlotPool(2, 1),
      held: new HeldRuns(),
      tokenRevoker: {
        revokeShortLivedToken: (token) => {
          revoked.push(token.reveal());
          return Promise.resolve();
        },
      },
      clone: (clone) => {
        const repo = path.join(clone.dir, 'repo');
        execFileSync('git', ['clone', '-q', '--no-hardlinks', src.dir, repo]);
        execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'evaluation', clone.baseSha]);
        fs.mkdirSync(path.join(clone.dir, 'home'), { recursive: true });
        return Promise.resolve(repo);
      },
      now: () => TASK_NOW,
      ...over,
    };
  }

  const run = (input: CheckEvaluationTaskInput, over: Partial<CheckTaskDeps> = {}) =>
    checkTask(deps(over), input, { signal: new AbortController().signal });

  it('checks a good task: two scorings, the hidden test from the merge, the solution without it', async () => {
    const input = await handedOver();
    expect(await run(input, { score: scorer(BASE_FAILS, PASS) })).toEqual({ outcome: 'checked' });
    expect(revoked).toEqual([TOKEN]);
    expect(scored).toHaveLength(2);
    const [base, solution] = scored;
    expect(base!.input.agentPatch).toBe('');
    expect(base!.hidden).toEqual(['src/tax.spec.ts']);
    // The base adds the spec where the agent reads it; the solution changes tax.ts only.
    expect(base!.base).toContain('docs/specs/tax-rule.md');
    expect(solution!.input.agentPatch).toContain('src/tax.ts');
    expect(solution!.input.agentPatch).not.toContain('tax.spec.ts');
    expect(solution!.input.task).toMatchObject({ failToPass: ['pnpm test -- src/tax.spec.ts'] });
    expect(solution!.input.runId).toBe(input.evaluationTaskId);
  });

  it.each([
    ['hidden tests that pass without the change', [PASS, PASS], 'passes_without_change'],
    ['a solution that does not pass', [BASE_FAILS, BASE_FAILS], 'solution_fails'],
    ['a base that does not apply', [{ ...BASE_FAILS, applied: false }], 'solution_fails'],
    ['an install that fails (pnpm only)', [new ScoringError('install_failed')], 'install_failed'],
  ] as const)('fails a task with %s', async (_name, results, code) => {
    const input = await handedOver();
    expect(await run(input, { score: scorer(...results) })).toEqual({
      outcome: 'check_failed',
      code,
    });
  });

  it('fails a changed card and a spec with another hash, before any scoring', async () => {
    // The Git host showed this text as the card, but the repository has another one.
    const changed = await handedOver(src.cardCommit, `${src.card}# edited\n`);
    expect(await run(changed, { score: scorer() })).toEqual({
      outcome: 'check_failed',
      code: 'card_changed',
    });
    const badSpec = await handedOver(src.badSpecCommit, src.badSpecCard);
    expect(await run(badSpec, { score: scorer() })).toEqual({
      outcome: 'check_failed',
      code: 'spec_changed',
    });
    expect(scored).toEqual([]);
  });

  it('refuses an expired contract and a check another worker holds', async () => {
    const input = await handedOver();
    expect(await run(input, { now: () => new Date(TASK_NOW.getTime() + 48 * 3_600_000) })).toEqual({
      outcome: 'refused',
      reason: 'expired',
    });
    const held = new HeldRuns();
    held.hold(input.evaluationTaskId);
    expect(await run(input, { held })).toEqual({ outcome: 'refused', reason: 'run_not_startable' });
  });

  it('scores in the stub Docker containers and leaves nothing behind', async () => {
    const input = await handedOver();
    // The stub answers the same line for both scorings: the hidden tests fail both times.
    docker.stdout.set(
      `sdlc-sandbox-${input.evaluationTaskId}`,
      '{"applied":true,"ci":true,"pass_to_pass":true,"fail_to_pass":false,"lint":0}\n',
    );
    expect(await run(input)).toEqual({ outcome: 'check_failed', code: 'solution_fails' });
    expect(docker.containers.size).toBe(0);
  });
});
