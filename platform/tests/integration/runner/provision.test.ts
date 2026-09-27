// D-08 C04 AC1, AC2, AC4, AC5 end to end on a real Docker Engine and PostgreSQL (ADR-M25 §2.8):
// the worker issues and signs the Run Contract and wraps the GitHub token (QUESTIONS #44); the
// runner verifies, claims, unwraps, clones `base_sha` onto `agent/INT-…` from a local Git host,
// starts the sandbox from the project image (config `sandbox.image`, pinned by digest) and waits
// for its health check. From inside, the sandbox sees the branch and no Git credential, reaches
// LiteLLM and nothing else. Then the runner removes everything.
//
// `pnpm test:runner` (SDLC_RUNNER_TEST=1, throw-away PostgreSQL from test-db.sh; CI job `compose`).
// OpenBao is the in-process stub (Transit and response wrapping); `pnpm test:openbao` checks
// wrapping and the new policies on a real OpenBao.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import { OpenBaoClient, Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DockerClient,
  HeldRuns,
  LABELS,
  provisionRun,
  reconcileOnStart,
  releaseSandbox,
  runLabels,
  runnerSettingsFromEnv,
  type RunnerDeps,
} from '../../../apps/runner/src/index.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { issueRunContract } from '../../../packages/core/src/run-contract/index.js';
import { StubGitHost } from '../../runner/stub-git.js';
import { credentialFiles, StubOpenBao } from '../../secrets/stub-openbao.js';
import { seedAgent } from '../agent-seed.js';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import {
  BUSYBOX,
  buildFixtureImage,
  docker,
  dockerSocket,
  liveEnabled,
  quietly,
  startStub,
  waitForProbes,
  type FixtureImage,
} from './live-helpers';

const TOKEN = `ghs_c04Live${crypto.randomBytes(12).toString('hex')}`;
const suffix = crypto.randomBytes(4).toString('hex');
const instance = `c04-flow-${suffix}`;
const platformNet = `sdlc-c04-flow-platform-${suffix}`;
const litellm = `sdlc-c04-flow-litellm-${suffix}`;

describe.skipIf(!liveEnabled || !process.env.SDLC_TEST_DATABASE_URL)(
  'C04 live: provisioning flow end to end',
  () => {
    let t: TestDatabase;
    let bao: StubOpenBao;
    let files: ReturnType<typeof credentialFiles>;
    let worker: OpenBaoClient;
    let runner: OpenBaoClient;
    let git: StubGitHost;
    let fixture: FixtureImage | undefined;
    let workDir: string;
    let deps: RunnerDeps;

    beforeAll(async () => {
      t = await createTestDatabase();
      bao = await StubOpenBao.start();
      files = credentialFiles();
      const options = {
        address: bao.address,
        allowPlaintext: true,
        roleIdFile: files.roleIdFile,
        secretIdFile: files.secretIdFile,
      };
      worker = new OpenBaoClient(options);
      runner = new OpenBaoClient(options);
      git = await StubGitHost.start(TOKEN);
      docker('pull', '-q', BUSYBOX);
      fixture = await buildFixtureImage(suffix);
      docker('network', 'create', platformNet);
      startStub(litellm, platformNet, 4000);
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-runner-live-'));
      const runnerKey = runner.transit();
      deps = {
        db: t.app as unknown as RunnerDeps['db'],
        docker: new DockerClient({ socketPath: dockerSocket(), timeoutMs: 120_000 }),
        settings: runnerSettingsFromEnv({
          SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
          SDLC_RUNNER_INSTANCE: instance,
          SDLC_RUNNER_SANDBOX_MEMORY_MB: '256',
          SDLC_RUNNER_EGRESS_SERVICES: `litellm=${litellm}:4000`,
          SDLC_RUNNER_GIT_BASE_URL: git.origin,
          SDLC_RUNNER_GIT_ALLOW_PLAINTEXT: '1',
          SDLC_RUNNER_WORK_DIR: workDir,
          SDLC_RUNNER_READY_TIMEOUT_SECONDS: '120',
        }),
        verifier: {
          verify: (payload, signature) => runnerKey.verifyLocally(payload, signature),
          publicKey: (version) => runnerKey.publicKey(version),
        },
        unwrapper: runner.wrapping(),
        held: new HeldRuns(),
      };
    }, 300_000);

    afterAll(async () => {
      quietly('rm', '-f', '-v', litellm);
      quietly('network', 'rm', platformNet);
      fixture?.cleanup();
      await worker?.close();
      await runner?.close();
      await bao?.stop();
      await git?.stop();
      if (files) fs.rmSync(files.dir, { recursive: true, force: true });
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
      await t?.drop();
    }, 120_000);

    /** Worker side: tenant, project with its sandbox image, intent, plan, signed contract. */
    async function prepareRun(slug: string) {
      const repo = `org/pilot-${slug}`;
      const { first: baseSha } = git.createRepo(repo, {
        'README.md': 'pilot\n',
        'probe-targets': 'litellm litellm 4000\ngithub api.github.com 443\n',
      });

      // Worker side: tenant, project with its sandbox image, intent, plan, signed contract.
      const tenant = await t.app.system.createTenant({ slug, name: slug });
      const scope = t.app.forTenant(parseTenantId(tenant.id));
      const project = await scope.projects.create({
        slug: 'shop',
        name: 'Shop',
        git_provider: 'github',
        repo_full_name: repo,
      });
      const configYaml = `sandbox:\n  image: ${fixture!.image}\n`;
      const loaded = loadProjectConfig(configYaml);
      if (!loaded.ok) throw new Error('fixture image reference refused by the configuration');
      await scope.projectConfigs.save(project.id, {
        configYaml,
        configHash: loaded.configHash,
        updatedBy: null,
        expectedVersion: 0,
      });
      const personA = (await scope.users.create({ display_name: 'a', email: 'a@example.com' })).id;
      const personB = (await scope.users.create({ display_name: 'b', email: 'b@example.com' })).id;
      const registry = new Registry({
        policyFactory: (config) => createSimplePolicyEngine({ config }),
      });
      const intent = await registry.createIntent(scope, {
        projectId: project.id,
        title: 'Add Japanese labels',
        createdBy: personA,
        riskTier: 'low',
        dataClass: 'internal',
      });
      const plan = await registry.submitPlan(scope, intent.id, {
        plannedFiles: ['README.md'],
        planSha256: 'b'.repeat(64),
        actorType: 'human',
        actorId: personA,
      });
      const agent = await seedAgent(scope, personA);
      const { envelope } = await issueRunContract(
        scope,
        {
          intentId: intent.id,
          planId: plan.id,
          baseSha,
          agent: {
            id: agent.id,
            version: '1.0.0',
            instructionsSha256: 'c'.repeat(64),
            tools: ['editor'],
          },
          planTools: ['editor'],
          autonomyLevel: 'L2',
          maxBudgetUsd: '1',
          maxIterations: 10,
          maxDurationMin: 10,
          allowedModels: ['stub'],
          egressAllowlist: ['litellm:4000'],
          triggeredBy: personB,
        },
        { signer: worker.transit() },
      );
      const wrapped = await worker
        .wrapping()
        .wrap({ token: new Redacted(TOKEN) }, { ttlSeconds: 900 });

      return { tenant, scope, envelope, wrapped };
    }

    it('verifies, clones, starts a healthy sandbox with the branch and no credential, then cleans up', async () => {
      const { tenant, scope, envelope, wrapped } = await prepareRun('live');

      // Runner side.
      const result = await provisionRun(deps, { envelope, wrappedGitToken: wrapped });
      if (!result.ok) throw new Error(`provisioning failed: ${result.reason}`);
      const runId = envelope.contract.run_id;
      expect(await scope.runs.getById(runId)).toMatchObject({ status: 'running' });

      const probes = Object.fromEntries(
        await waitForProbes(deps.docker, result.sandbox.containerId),
      );
      expect(probes).toMatchObject({
        litellm: 'open',
        github: 'blocked',
        branch: envelope.contract.branch, // AC2
        git_auth: 'absent', // no credential in the workspace (AC4)
        readme: 'pilot',
        workspace: 'writable',
        rootfs: 'readonly',
        uid: '10001',
        canary: 'absent',
        secret_env: 'absent',
        default_route: 'none',
      });
      const info = await deps.docker.containerInspect(result.sandbox.containerId);
      expect(JSON.stringify(info)).not.toContain(TOKEN);
      expect(info?.State.Health?.Status).toBe('healthy');
      expect(fs.readdirSync(workDir)).toEqual([]); // the clone left the runner's disk

      // AC5: release removes everything and records it.
      await releaseSandbox(deps, tenant.id, runId, 'finished');
      const labels = { [LABELS.instance]: instance };
      expect(await deps.docker.containerList(labels)).toEqual([]);
      expect(await deps.docker.networkList(labels)).toEqual([]);
      expect(await deps.docker.volumeList(labels)).toEqual([]);
      expect((await scope.runEvents.list(runId)).map((e) => e.event_type)).toEqual([
        'contract_issued',
        'contract_accepted',
        'workspace_prepared',
        'sandbox_created',
        'sandbox_ready',
        'sandbox_removed',
      ]);
    }, 300_000);

    it('cleans up after a runner restart: sandbox, network, volume gone; run failed (AC5)', async () => {
      const { tenant, scope, envelope, wrapped } = await prepareRun('restart');
      const result = await provisionRun(deps, { envelope, wrappedGitToken: wrapped });
      if (!result.ok) throw new Error(`provisioning failed: ${result.reason}`);
      const runId = envelope.contract.run_id;
      // Another runner deployment on the same host: its objects must survive.
      const foreign = `sdlc-ws-${crypto.randomUUID()}`;
      const foreignLabels = runLabels(`${instance}-other`, crypto.randomUUID(), tenant.id);
      docker(
        'volume',
        'create',
        ...Object.entries(foreignLabels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
        foreign,
      );
      try {
        // The old process is gone: a new one starts with nothing in memory.
        const restarted = await reconcileOnStart({
          db: deps.db,
          docker: deps.docker,
          settings: deps.settings,
        });
        expect(restarted).toEqual({ runs: 1, failedRuns: 1, errors: 0 });
        const labels = { [LABELS.instance]: instance };
        expect(await deps.docker.containerList(labels)).toEqual([]);
        expect(await deps.docker.networkList(labels)).toEqual([]);
        expect(await deps.docker.volumeList(labels)).toEqual([]);
        expect(await scope.runs.getById(runId)).toMatchObject({
          status: 'failed',
          stop_reason: 'runner_restarted',
        });
        expect((await scope.runEvents.list(runId)).map((e) => e.event_type).slice(-2)).toEqual([
          'run_abandoned',
          'sandbox_removed',
        ]);
        expect(docker('volume', 'ls', '-q', '--filter', `name=${foreign}`)).toBe(foreign);
      } finally {
        quietly('volume', 'rm', foreign);
        deps.held.release(runId);
      }
    }, 300_000);
  },
);
