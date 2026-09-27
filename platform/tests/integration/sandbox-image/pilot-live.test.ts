// Opt-in live test of the whole C04 flow against the real pilot repository (D-08 C04 AC1–AC5,
// ADR-M25): the real Agent Server image (node24 on the pinned base), a real single-repository
// token from the TEST GitHub App, the real Verdaccio, a throw-away PostgreSQL. Never in CI (a
// static test checks that no workflow sets its variables) and never with a model-provider key: no
// model is called. Run it in a terminal on a developer machine, not through a chat tool:
//
//   SDLC_SANDBOX_LIVE_TEST=1 \
//   SDLC_GITHUB_TEST_APP_FILE=/path/outside/the/repo/github-test-app.json \
//   pnpm test:sandbox-live
//
// The JSON file is the one of the GitHub adapter's live test (tests/integration/github/live.test.ts):
//   { "client_id": "Iv…", "private_key_file": "/path/outside/the/repo/test-app.pem",
//     "repo": "harryforge/pilot-order-inventory", "commit_sha": "<40 hex>", … }
// `commit_sha` is the base commit of the run. OpenBao is the in-process stub (Transit and
// response wrapping): the token goes through wrap and unwrap exactly as between worker and runner.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import type { SecretReader } from '@sdlc/contracts';
import { OpenBaoClient, Redacted } from '@sdlc/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DockerClient,
  HeldRuns,
  LABELS,
  provisionRun,
  releaseSandbox,
  runnerSettingsFromEnv,
  SANDBOX_ENV_ALLOWLIST,
  type RunnerDeps,
} from '../../../apps/runner/src/index.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { issueRunContract } from '../../../packages/core/src/run-contract/index.js';
import { repoRoot } from '../../workspace/helpers';
import { credentialFiles, StubOpenBao } from '../../secrets/stub-openbao.js';
import { seedAgent } from '../agent-seed.js';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import { BUSYBOX, docker, dockerSocket } from '../runner/live-helpers';
import { IMAGE_ENV, sh, startInfrastructure, type Infrastructure } from './helpers';

const enabled =
  process.env.SDLC_SANDBOX_LIVE_TEST === '1' &&
  Boolean(process.env.SDLC_GITHUB_TEST_APP_FILE) &&
  Boolean(process.env.SDLC_TEST_DATABASE_URL);

interface LiveSettings {
  client_id: string;
  private_key_file: string;
  repo: string;
  commit_sha: string;
}

function outsideRepo(file: string): string {
  const resolved = path.resolve(file);
  const root = repoRoot();
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${resolved} is inside the repository; keep test App files outside it`);
  }
  return resolved;
}

const suffix = crypto.randomBytes(4).toString('hex');
const instance = `c04-pilot-${suffix}`;

describe.skipIf(!enabled)('C04 live: the pilot repository in a node24 sandbox', () => {
  let s: LiveSettings;
  let token = '';
  let t: TestDatabase;
  let bao: StubOpenBao;
  let files: ReturnType<typeof credentialFiles>;
  let worker: OpenBaoClient;
  let runner: OpenBaoClient;
  let infra: Infrastructure | undefined;
  let workDir: string;
  let deps: RunnerDeps;

  beforeAll(async () => {
    s = JSON.parse(
      fs.readFileSync(outsideRepo(process.env.SDLC_GITHUB_TEST_APP_FILE!), 'utf8'),
    ) as LiveSettings;
    expect(s.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    const pem = fs.readFileSync(outsideRepo(s.private_key_file), 'utf8');
    // Production reads the key from OpenBao; here the file feeds an in-memory SecretReader.
    const secrets: SecretReader = {
      read: () =>
        Promise.resolve({
          version: 1,
          data: { client_id: { reveal: () => s.client_id }, private_key: { reveal: () => pem } },
        }),
    };
    const [owner = '', name = ''] = s.repo.split('/');
    const issued = await new GitHubAdapter({ secrets }).issueShortLivedToken(
      { owner, name },
      { permissions: { contents: 'read' } },
    );
    token = issued.token.reveal();

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
    docker('pull', '-q', BUSYBOX);
    infra = await startInfrastructure(suffix);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-runner-pilot-'));
    const runnerKey = runner.transit();
    deps = {
      db: t.app as unknown as RunnerDeps['db'],
      docker: new DockerClient({ socketPath: dockerSocket(), timeoutMs: 900_000 }),
      settings: runnerSettingsFromEnv({
        SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
        SDLC_RUNNER_INSTANCE: instance,
        SDLC_RUNNER_EGRESS_SERVICES: infra.egressServices,
        SDLC_RUNNER_NPM_REGISTRY: 'http://npm-proxy:4873/',
        SDLC_RUNNER_WORK_DIR: workDir,
      }),
      verifier: {
        verify: (payload, signature) => runnerKey.verifyLocally(payload, signature),
        publicKey: (version) => runnerKey.publicKey(version),
      },
      unwrapper: runner.wrapping(),
      held: new HeldRuns(),
    };
  }, 1_200_000);

  afterAll(async () => {
    infra?.cleanup();
    await worker?.close();
    await runner?.close();
    await bao?.stop();
    if (files) fs.rmSync(files.dir, { recursive: true, force: true });
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    await t?.drop();
  }, 120_000);

  it('clones the pilot repo at base_sha into a healthy node24 sandbox, then removes it', async () => {
    // Worker side: tenant, project with the node24 image, intent, plan, signed contract.
    const tenant = await t.app.system.createTenant({ slug: 'pilot', name: 'pilot' });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'pilot',
      name: 'Pilot',
      git_provider: 'github',
      repo_full_name: s.repo,
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
      title: 'C04 pilot live test',
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
        baseSha: s.commit_sha,
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
        egressAllowlist: ['litellm:4000', 'npm-proxy:4873'],
        triggeredBy: personB,
      },
      { signer: worker.transit() },
    );
    const wrapped = await worker
      .wrapping()
      .wrap({ token: new Redacted(token) }, { ttlSeconds: 900 });

    // Runner side: the real flow.
    const result = await provisionRun(deps, { envelope, wrappedGitToken: wrapped });
    if (!result.ok) throw new Error(`provisioning failed: ${result.reason}`);
    const runId = envelope.contract.run_id;
    const container = result.sandbox.names.container;
    try {
      expect(await scope.runs.getById(runId)).toMatchObject({ status: 'running' });

      // AC2: the pilot repo at base_sha on agent/INT-…, no credential in the workspace.
      expect(sh(container, 'git -C /workspace rev-parse HEAD').out).toBe(s.commit_sha);
      expect(sh(container, 'git -C /workspace symbolic-ref --short HEAD').out).toBe(
        envelope.contract.branch,
      );
      expect(sh(container, 'cat /workspace/.git/config').out).not.toMatch(
        /extraheader|authorization|x-access-token/i,
      );
      expect(sh(container, 'test -f /workspace/README.md && echo yes').out).toBe('yes');

      // AC1: packages through the proxy only; GitHub and the npm registry are not reachable.
      expect(sh(container, 'npm view left-pad@1.3.0 version').out).toBe('1.3.0');
      const blocked = (url: string) =>
        sh(container, `curl -sS -m 5 -o /dev/null ${url} && echo open || echo blocked`).out;
      expect(blocked('https://github.com/')).toBe('blocked');
      expect(blocked('https://registry.npmjs.org/')).toBe('blocked');
      // Once R01 adds a lockfile: the project's dependencies install from the proxy.
      if (sh(container, 'test -f /workspace/pnpm-lock.yaml && echo yes').out === 'yes') {
        expect(sh(container, 'cd /workspace && pnpm install --frozen-lockfile').code).toBe(0);
      }

      // AC4: the environment is the allowlist; no token anywhere in the container definition.
      const info = await deps.docker.containerInspect(result.sandbox.containerId);
      expect(JSON.stringify(info)).not.toContain(token);
      const allowed = new Set<string>(SANDBOX_ENV_ALLOWLIST);
      const env = (info?.Config.Env ?? []).map((e) => e.split('=')[0]!);
      expect(env.filter((n) => !IMAGE_ENV.has(n)).every((n) => allowed.has(n))).toBe(true);
      expect(info?.State.Health?.Status).toBe('healthy');
      expect(fs.readdirSync(workDir)).toEqual([]); // the clone left the runner's disk
    } finally {
      // AC5: nothing of the run is left.
      await releaseSandbox(deps, tenant.id, runId, 'finished');
    }
    const labels = { [LABELS.instance]: instance };
    expect(await deps.docker.containerList(labels)).toEqual([]);
    expect(await deps.docker.networkList(labels)).toEqual([]);
    expect(await deps.docker.volumeList(labels)).toEqual([]);
  }, 900_000);
});
