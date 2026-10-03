// Opt-in live test: an L1 proposal of a realistic workspace (C06 session 2b, Harry's review of
// PR #112). The public pilot repository (copied from GitHub into the local stub Git host, so no
// GitHub App key is needed) is provisioned into a node24 sandbox, `pnpm install` fills
// `node_modules` through the real Verdaccio, the "agent" changes two files, and the runner stores
// the proposal. The test samples the runner process's memory while the proposal is computed.
// Needs Docker and internet (GitHub, npm). Developer machines only, not in CI:
//
//   pnpm test:proposal-pilot
//
// `SDLC_PROPOSAL_REPORT=<file>` writes the measurement as JSON. `SDLC_SANDBOX_IMAGE` skips the
// node24 build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import type { EvidenceStore, StoredEvidence } from '@sdlc/contracts';
import { OpenBaoClient, Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DockerClient,
  HeldRuns,
  provisionRun,
  releaseSandbox,
  runnerSettingsFromEnv,
  storeProposal,
  type RunnerDeps,
} from '../../../apps/runner/src/index.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { issueRunContract } from '../../../packages/core/src/run-contract/index.js';
import { StubGitHost } from '../../runner/stub-git.js';
import { credentialFiles, StubOpenBao } from '../../secrets/stub-openbao.js';
import { seedAgent } from '../agent-seed.js';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import { BUSYBOX, docker, dockerSocket } from '../runner/live-helpers';
import { sh, startInfrastructure, type Infrastructure } from './helpers';

const enabled =
  process.env.SDLC_PROPOSAL_PILOT_TEST === '1' && Boolean(process.env.SDLC_TEST_DATABASE_URL);
const PILOT = 'https://github.com/harryforge/pilot-order-inventory.git';
const REPO = 'harryforge/pilot-order-inventory';
const TOKEN = `ghs_pilotProposal${crypto.randomBytes(12).toString('hex')}`;
const MIB = 1024 * 1024;
const suffix = crypto.randomBytes(4).toString('hex');
const instance = `c06-proposal-${suffix}`;

/** Samples the process memory every 20 ms until stopped; returns the peaks above the baseline. */
function sampleMemory(): () => { rssMb: number; externalMb: number; heapMb: number } {
  const base = process.memoryUsage();
  let peak = { ...base };
  const timer = setInterval(() => {
    const now = process.memoryUsage();
    peak = {
      ...peak,
      rss: Math.max(peak.rss, now.rss),
      external: Math.max(peak.external, now.external),
      heapUsed: Math.max(peak.heapUsed, now.heapUsed),
    };
  }, 20);
  return () => {
    clearInterval(timer);
    const round = (n: number) => Math.round((n / MIB) * 10) / 10;
    return {
      rssMb: round(peak.rss - base.rss),
      externalMb: round(peak.external - base.external),
      heapMb: round(peak.heapUsed - base.heapUsed),
    };
  };
}

describe.skipIf(!enabled)(
  'C06 live: an L1 proposal of the pilot repository after pnpm install',
  () => {
    let t: TestDatabase;
    let bao: StubOpenBao;
    let files: ReturnType<typeof credentialFiles>;
    let worker: OpenBaoClient;
    let runner: OpenBaoClient;
    let git: StubGitHost;
    let infra: Infrastructure | undefined;
    let workDir: string;
    let deps: RunnerDeps;
    let baseSha: string;

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
      baseSha = git.importRepo(REPO, PILOT);
      docker('pull', '-q', BUSYBOX);
      infra = await startInfrastructure(suffix);
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-runner-proposal-'));
      const runnerKey = runner.transit();
      deps = {
        db: t.app as unknown as RunnerDeps['db'],
        docker: new DockerClient({ socketPath: dockerSocket(), timeoutMs: 900_000 }),
        settings: runnerSettingsFromEnv({
          SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
          SDLC_RUNNER_INSTANCE: instance,
          SDLC_RUNNER_EGRESS_SERVICES: infra.egressServices,
          SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
          SDLC_RUNNER_GIT_BASE_URL: git.origin,
          SDLC_RUNNER_GIT_ALLOW_PLAINTEXT: '1',
          SDLC_RUNNER_WORK_DIR: workDir,
          SDLC_RUNNER_READY_TIMEOUT_SECONDS: '300',
        }),
        verifier: {
          verify: (payload, signature) => runnerKey.verifyLocally(payload, signature),
          publicKey: (version) => runnerKey.publicKey(version),
        },
        unwrapper: runner.wrapping(),
        held: new HeldRuns(),
      };
    }, 1_800_000);

    afterAll(async () => {
      infra?.cleanup();
      await worker?.close();
      await runner?.close();
      await bao?.stop();
      await git?.stop();
      if (files) fs.rmSync(files.dir, { recursive: true, force: true });
      if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
      await t?.drop();
    }, 120_000);

    it('leaves node_modules out, keeps peak memory well under the workspace cap', async () => {
      const tenant = await t.app.system.createTenant({ slug: 'pilot', name: 'pilot' });
      const scope = t.app.forTenant(parseTenantId(tenant.id));
      const project = await scope.projects.create({
        slug: 'pilot',
        name: 'Pilot',
        git_provider: 'github',
        repo_full_name: REPO,
      });
      const configYaml = `sandbox:\n  image: ${infra!.image}\n`;
      const loaded = loadProjectConfig(configYaml);
      if (!loaded.ok) throw new Error('node24 image reference refused by the configuration');
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
        title: 'C06 proposal of the pilot repository',
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
          autonomyLevel: 'L1',
          maxBudgetUsd: '1',
          maxIterations: 10,
          maxDurationMin: 30,
          allowedModels: ['stub'],
          egressAllowlist: ['litellm:4000', 'npm-proxy:4873'],
          triggeredBy: personB,
        },
        { signer: worker.transit() },
      );
      const wrapped = await worker
        .wrapping()
        .wrap({ token: new Redacted(TOKEN) }, { ttlSeconds: 900 });

      const result = await provisionRun(deps, { envelope, wrappedGitToken: wrapped });
      if (!result.ok) throw new Error(`provisioning failed: ${result.reason}`);
      const runId = envelope.contract.run_id;
      const container = result.sandbox.names.container;
      const cloneDir = result.cloneDir;
      try {
        const install = sh(container, 'cd /workspace && pnpm install --frozen-lockfile');
        expect(install.code).toBe(0);
        sh(container, 'cd /workspace && echo "Changed by the proposal test." >> README.md');
        sh(container, 'cd /workspace && mkdir -p docs/notes && echo note > docs/notes/proposal.md');
        const bytes = (cmd: string) => Number(sh(container, cmd).out.split(/\s+/)[0]);
        const workspaceMb = Math.round(bytes('du -sk /workspace') / 1024);
        const nodeModulesMb = Math.round(bytes('du -sk /workspace/node_modules') / 1024);
        const files = Number(sh(container, 'find /workspace -xdev | wc -l').out);

        let stored = { sizeBytes: 0 };
        const evidence: EvidenceStore = {
          put: (tenantId, p, content): Promise<StoredEvidence> => {
            stored = { sizeBytes: content.length };
            return Promise.resolve({
              uri: `s3://evidence/proposals/${tenantId}/${p}`,
              sha256: crypto.createHash('sha256').update(content).digest('hex'),
              sizeBytes: content.length,
            });
          },
          get: () => Promise.reject(new Error('not used')),
        };
        const started = Date.now();
        const stop = sampleMemory();
        const proposal = await storeProposal({ ...deps, evidence }, envelope.contract, cloneDir);
        const peak = stop();
        const seconds = Math.round((Date.now() - started) / 100) / 10;

        const report = {
          base_sha: baseSha,
          workspace_mb: workspaceMb,
          node_modules_mb: nodeModulesMb,
          workspace_entries: files,
          changed_files: proposal.changedFiles,
          patch_bytes: stored.sizeBytes,
          seconds,
          peak_above_baseline: peak,
          workspace_cap_mb: deps.settings.workspaceMaxBytes / MIB,
        };
        if (process.env.SDLC_PROPOSAL_REPORT) {
          fs.writeFileSync(
            process.env.SDLC_PROPOSAL_REPORT,
            `${JSON.stringify(report, null, 2)}\n`,
          );
        }
        expect(nodeModulesMb).toBeGreaterThan(50); // a realistic workspace
        expect(proposal.changedFiles).toBe(2); // README.md and docs/notes/proposal.md
        // "Well under the workspace cap": a quarter of it at most.
        expect(peak.rssMb).toBeLessThan(deps.settings.workspaceMaxBytes / MIB / 4);
      } finally {
        await releaseSandbox(deps, tenant.id, runId, 'finished');
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }
    }, 1_800_000);
  },
);
