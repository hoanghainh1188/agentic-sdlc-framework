// An evaluation run on the server, live, on the stub model (task L04, design/ADR-M81 §2.3–§2.8,
// AC5): `executeEvaluation` of the runner against a real Docker Engine, the sandbox image, the real
// OpenHands Agent Server, the package proxy and a scripted stub model, on task `feat-tax` of task
// set v1 (its title carries the stub's marker `[stub:edit]`, so the stub edits a file outside the
// plan). `pnpm test:eval-server` (SDLC_EVAL_SERVER_TEST=1, a throw-away PostgreSQL from
// test-db.sh). Developer machines and the owner's checks; no secret (the keys are random values of
// this run). Needs Docker and internet (the sample repository at its pinned commit, npm packages
// through Verdaccio, cached in the volume `sdlc-eval-npm-cache`).
//
// - The measures are what the stub run gives on a developer machine (ADR-M78: one file changed
//   outside the plan, one line added, the repository's checks and `pass_to_pass` pass, the hidden
//   tests do not), and scoring the same patches with `LocalExecutor` gives the same score: both
//   places score the same way.
// - The run stays `running` for the worker to write the result; the evaluation tables, the audit
//   events, the cost records, the returned value and the process output hold none of the canaries
//   (the clone token, the virtual key, the task text, the stub's file content): the canary search of
//   ADR-M80 §4.1.
// - Nothing is left behind: no container, network or volume of the runner instance.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OpenHandsAdapter } from '@sdlc/adapter-agent-openhands';
import type { RunContractSigner, RunContractVerifier } from '@sdlc/contracts';
import { ensureClone, loadTaskSet, LocalExecutor, type TaskSet } from '@sdlc/eval';
import { Redacted } from '@sdlc/secrets';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DockerClient,
  executeEvaluation,
  HeldRuns,
  runnerSettingsFromEnv,
  SlotPool,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import { issueEvaluationContract } from '../../../packages/core/src/evaluation/index.js';
import { deployDir } from '../../deploy/compose';
import { here, NODE_IMAGE } from '../agent/helpers';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import { seedEvaluation, type SeededEvaluation } from '../evaluation-seed.js';
import { docker, dockerSocket, quietly } from '../runner/live-helpers';
import { buildSandboxImage, VERDACCIO } from '../sandbox-image/helpers';
import { repoRoot } from '../../workspace/helpers';

const enabled = process.env.SDLC_EVAL_SERVER_TEST === '1' && !!process.env.SDLC_TEST_DATABASE_URL;
const suffix = crypto.randomBytes(4).toString('hex');
const names = {
  net: `sdlc-evs-platform-${suffix}`,
  stub: `sdlc-evs-stub-${suffix}`,
  npm: `sdlc-evs-npm-${suffix}`,
  registry: `sdlc-evs-registry-${suffix}`,
};
const INSTANCE = `evs-${suffix}`;
const NPM_CACHE_VOLUME = 'sdlc-eval-npm-cache';
const CACHE = process.env.SDLC_EVAL_CACHE ?? path.join(os.homedir(), '.cache', 'sdlc-eval');
// Canaries: made up for this test, planted where the platform holds the real thing.
const TOKEN = `ghs_evalLiveCanary${crypto.randomBytes(8).toString('hex')}`;
const KEY = `sk-eval-live-canary-${crypto.randomBytes(8).toString('hex')}`;

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

describe.skipIf(!enabled)(
  'L04 PR 4c: an evaluation run on the server, live, on the stub model',
  () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-server-'));
    let t: TestDatabase;
    let set: TaskSet;
    let clone: string;
    let image: string;
    let client: DockerClient;
    let settings: RunnerSettings;
    let world: SeededEvaluation;
    let relayUrl = '';
    let relay = '';

    beforeAll(async () => {
      set = loadTaskSet(path.join(repoRoot(), 'platform/eval/tasks/v1'), ['feat-tax']);
      clone = ensureClone(CACHE, set);
      // A private copy of the task set whose task title carries the stub's marker.
      const tasks = path.join(tmp, 'tasks');
      fs.cpSync(path.join(repoRoot(), 'platform/eval/tasks/v1'), tasks, { recursive: true });
      const taskFile = path.join(tasks, 'feat-tax/task.yaml');
      fs.writeFileSync(
        taskFile,
        fs
          .readFileSync(taskFile, 'utf8')
          .replace(/^title: (.*)$/m, (_line, rest: string) => `title: "[stub:edit] ${rest}"`),
      );
      image = process.env.SDLC_SANDBOX_IMAGE || (await buildSandboxImage(names.registry));
      t = await createTestDatabase();

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
      docker('pull', '-q', NODE_IMAGE);
      docker(
        'run',
        '-d',
        '--name',
        names.stub,
        '--network',
        names.net,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--user',
        '1000:1000',
        '-e',
        `STUB_EXPECTED_KEY=${KEY}`,
        '-v',
        `${path.join(here, 'stub-model.mjs')}:/stub/stub-model.mjs:ro`,
        NODE_IMAGE,
        'node',
        '/stub/stub-model.mjs',
      );
      client = new DockerClient({ socketPath: dockerSocket(), timeoutMs: 900_000 });

      world = await seedEvaluation(t.app, {
        slug: 'evs',
        baseSha: set.commit,
        configName: 'stub',
        configuration: {
          id: 'stub',
          model: 'stub-model',
          agentVersion: '1.0.0',
          maxIterations: 10,
          maxDurationMin: 5,
        },
        configYaml: `sandbox:\n  image: ${image}\n`,
      });
      // The relay stands in for the runner's own container (SDLC_RUNNER_SELF_CONTAINER).
      const runId = world.runs[0]!;
      relay = `sdlc-evs-relay-${runId.slice(0, 8)}`;
      docker(
        'run',
        '-d',
        '--name',
        relay,
        '-p',
        '127.0.0.1::8000',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--user',
        '1000:1000',
        '-e',
        `TARGET_HOST=sdlc-sandbox-${runId}`,
        '-v',
        `${path.join(here, 'relay.mjs')}:/relay/relay.mjs:ro`,
        NODE_IMAGE,
        'node',
        '/relay/relay.mjs',
      );
      const port = docker('port', relay, '8000/tcp').split('\n')[0]!.split(':').pop()!;
      relayUrl = `http://127.0.0.1:${port}`;
      settings = runnerSettingsFromEnv({
        SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
        SDLC_RUNNER_INSTANCE: INSTANCE,
        SDLC_RUNNER_EGRESS_SERVICES: `litellm=${names.stub}:4000,npm-proxy=${names.npm}:4873`,
        SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
        SDLC_RUNNER_SELF_CONTAINER: relay,
        SDLC_RUNNER_AGENT_POLL_MS: '250',
        SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS: '300',
        SDLC_RUNNER_WORK_DIR: path.join(tmp, 'work'),
        SDLC_EVAL_TASKS_DIR: tasks,
        SDLC_EVAL_CONFIG_DIR: path.join(repoRoot(), 'platform/eval/configs'),
      });
    }, 3_600_000);

    afterAll(async () => {
      quietly('rm', '-f', '-v', relay, names.stub, names.registry);
      quietly('rm', '-f', names.npm);
      quietly('network', 'rm', names.net);
      fs.rmSync(tmp, { recursive: true, force: true });
      await t?.drop();
    }, 300_000);

    it(
      'runs the evaluation run to its scored measures, scores like the developer machine, and leaks nothing',
      { timeout: 3_600_000 },
      async () => {
        const runId = world.runs[0]!;
        const transit = new FakeTransit();
        await issueEvaluationContract(
          world.scope,
          { evaluationRunId: runId, egressAllowlist: ['litellm:4000', 'npm-proxy:4873'] },
          { signer: transit },
        );
        const stderr: string[] = [];
        const log = (chunk: unknown) => stderr.push(String(chunk));
        const originalWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk: unknown) => {
          log(chunk);
          return true;
        };
        let patches: { basePatch: string; agentPatch: string } | undefined;
        let result;
        try {
          result = await executeEvaluation(
            {
              db: t.app as never,
              docker: client,
              settings,
              verifier: transit,
              unwrapper: {
                unwrap: (wrapped) =>
                  Promise.resolve<Record<string, Redacted>>(
                    wrapped.reveal() === 'wrap-git'
                      ? { token: new Redacted(TOKEN) }
                      : { key: new Redacted(KEY) },
                  ),
              },
              pool: new SlotPool(1, 1),
              held: new HeldRuns(),
              adapter: new OpenHandsAdapter({ requestTimeoutMs: 120_000 }),
              clone: (input) => {
                const repo = path.join(input.dir, 'repo');
                execFileSync('git', ['clone', '-q', '--no-hardlinks', clone, repo]);
                execFileSync('git', [
                  '-C',
                  repo,
                  'checkout',
                  '-q',
                  '-b',
                  'evaluation',
                  input.baseSha,
                ]);
                return Promise.resolve(repo);
              },
              agentUrl: () => relayUrl,
              onPatch: (p) => (patches = p),
            },
            {
              tenantId: world.scope.tenantId,
              evaluationRunId: runId,
              attempt: 1,
              wrappedGitToken: 'wrap-git',
              wrappedVirtualKey: 'wrap-key',
            },
            { signal: new AbortController().signal },
          );
        } finally {
          process.stderr.write = originalWrite;
        }

        // The stub edits a file outside the plan (ADR-M78): one file, one line, hidden tests fail.
        expect(result.outcome, JSON.stringify(result)).toBe('scored');
        if (result.outcome !== 'scored') return;
        expect(result.measures).toMatchObject({
          agentOutcome: 'finished',
          status: 'succeeded',
          outOfPlanFiles: 1,
          diffFiles: 1,
          diffLinesAdded: 1,
          diffLinesRemoved: 0,
          applied: true,
          ci: true,
          passToPass: true,
          failToPass: false,
          lintFindings: 0,
        });
        expect(result.measures.hardware.runner_instance).toBe(INSTANCE);
        expect(result.measures.hardware.docker_version).not.toBe('unknown');
        expect(await world.scope.evaluationRuns.getById(runId)).toMatchObject({
          status: 'running',
          attempt: 1,
        });

        // Both places score the same way: the same patches through `LocalExecutor`.
        expect(patches).toBeDefined();
        const local = new LocalExecutor({
          image,
          cloneDir: clone,
          commit: set.commit,
          proxyContainer: names.npm,
          proxyUrl: `http://${names.npm}:4873`,
        });
        const task = set.tasks[0]!;
        const localScore = await local.score({ task, ...patches! });
        expect({
          applied: result.measures.applied,
          ci: result.measures.ci,
          passToPass: result.measures.passToPass,
          failToPass: result.measures.failToPass,
          lintFindings: result.measures.lintFindings,
        }).toEqual({
          applied: localScore.applied,
          ci: localScore.ci,
          passToPass: localScore.passToPass,
          failToPass: localScore.failToPass,
          lintFindings: localScore.lintFindings,
        });

        // The canary search (ADR-M80 §4.1): the tables, the audit log, the returned value and the
        // process output hold no secret and no text of the task or of the agent.
        const rows = await Promise.all(
          [
            'evaluations',
            'evaluation_runs',
            'evaluation_run_contracts',
            'evaluation_run_results',
            'audit_log',
            'cost_records',
          ].map(async (table) =>
            JSON.stringify((await sql`select * from ${sql.table(table)}`.execute(t.owner)).rows),
          ),
        );
        const haystack = [...rows, JSON.stringify(result), stderr.join('')].join('\n');
        for (const canary of [TOKEN, KEY, 'Consumption tax', tmp]) {
          expect(haystack, canary).not.toContain(canary);
        }
        const leftovers = [
          docker('ps', '-a', '-q', '--filter', `label=sdlc.runner-instance=${INSTANCE}`),
          docker('network', 'ls', '-q', '--filter', `label=sdlc.runner-instance=${INSTANCE}`),
          docker('volume', 'ls', '-q', '--filter', `label=sdlc.runner-instance=${INSTANCE}`),
        ].join('');
        expect(leftovers).toBe('');
      },
    );
  },
);
