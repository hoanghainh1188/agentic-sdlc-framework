// D-08 C04 on PostgreSQL: the runner's provisioning flow (ADR-M25 §2.8) with stub Docker, stub
// OpenBao (Transit + response wrapping) and a stub Git host. Covers:
// - AC2: clone with the wrapped, single-use token; `agent/INT-…` at base_sha in the workspace;
// - AC3: one contract starts at most one sandbox (concurrent provisioning, QUESTIONS #35);
// - AC5: clean-up after a failure at each late step, and after the run (releaseSandbox);
// - QUESTIONS #44: a wrapping token used by someone else stops the run (`token_unavailable`);
// - run events and final run status for each outcome (coded payloads only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { RunContractVerifier } from '@sdlc/contracts';
import { OpenBaoClient, Redacted, type TransitKey } from '@sdlc/secrets';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  DockerClient,
  provisionRun,
  releaseSandbox,
  runnerSettingsFromEnv,
  type RunnerDeps,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import {
  issueRunContract,
  type IssueRunContract,
} from '../../../packages/core/src/run-contract/index.js';
import { StubDocker } from '../../runner/stub-docker.js';
import { StubGitHost } from '../../runner/stub-git.js';
import { credentialFiles, StubOpenBao } from '../../secrets/stub-openbao.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const TOKEN = 'ghs_c04ProvisionTokenCanary0000000000';
const REPO = 'org/pilot-order-inventory';
const SHA = (c: string) => c.repeat(64);
const DEFAULT_IMAGE =
  'ghcr.io/openhands/agent-server:1.48.0-python-slim@sha256:8fcfab2dedb4b41b6aef219b9fa9b1f2588033fad3d998ae6aa11fe8c4fcf8b7';

const registry = new Registry({ policyFactory: (config) => createSimplePolicyEngine({ config }) });

interface Seeded {
  readonly scope: TenantScope;
  readonly intentId: string;
  readonly planId: string;
  readonly personB: string;
}

describeDb('C04: runner provisioning flow on PostgreSQL', () => {
  let t: TestDatabase;
  let bao: StubOpenBao;
  let files: ReturnType<typeof credentialFiles>;
  let worker: OpenBaoClient;
  let runner: OpenBaoClient;
  let signingKey: TransitKey;
  let verifier: RunContractVerifier;
  let docker: StubDocker;
  let git: StubGitHost;
  let baseSha: string;
  let settings: RunnerSettings;
  let workDir: string;
  let deps: RunnerDeps;
  let tenantCount = 0;

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
    signingKey = worker.transit();
    const runnerKey = runner.transit();
    verifier = {
      verify: (payload, signature) => runnerKey.verifyLocally(payload, signature),
      publicKey: (version) => runnerKey.publicKey(version),
    };
    docker = await StubDocker.start();
    git = await StubGitHost.start(TOKEN);
    baseSha = git.createRepo(REPO, { 'README.md': 'pilot\n' }).first;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-runner-work-'));
    settings = runnerSettingsFromEnv({
      SDLC_RUNNER_DOCKER_SOCKET: docker.socketPath,
      SDLC_RUNNER_EGRESS_SERVICES: 'litellm=sdlc-litellm-1:4000',
      SDLC_RUNNER_GIT_BASE_URL: git.origin,
      SDLC_RUNNER_GIT_ALLOW_PLAINTEXT: '1',
      SDLC_RUNNER_WORK_DIR: workDir,
      SDLC_RUNNER_READY_TIMEOUT_SECONDS: '5',
    });
    deps = {
      // Same class; the test helpers import core from its sources, the runner by package name.
      db: t.app as unknown as RunnerDeps['db'],
      docker: new DockerClient({ socketPath: docker.socketPath, timeoutMs: 5000 }),
      settings,
      verifier,
      unwrapper: runner.wrapping(),
    };
  }, 60_000);

  afterAll(async () => {
    await worker?.close();
    await runner?.close();
    await bao?.stop();
    await docker?.stop();
    await git?.stop();
    if (files) fs.rmSync(files.dir, { recursive: true, force: true });
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    await t?.drop();
  });

  beforeEach(() => {
    docker.calls.length = 0;
    docker.failures.clear();
    docker.health = 'healthy';
    docker.images.add(DEFAULT_IMAGE);
  });

  async function seed(): Promise<Seeded> {
    const slug = `tenant-${String(++tenantCount)}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: REPO,
    });
    const personA = (await scope.users.create({ display_name: 'a', email: 'a@example.com' })).id;
    const personB = (await scope.users.create({ display_name: 'b', email: 'b@example.com' })).id;
    const intent = await registry.createIntent(scope, {
      projectId: project.id,
      title: 'Add Japanese labels',
      createdBy: personA,
      riskTier: 'low',
      dataClass: 'internal',
    });
    const plan = await registry.submitPlan(scope, intent.id, {
      plannedFiles: ['apps/web/src/products/**'],
      planSha256: SHA('b'),
      actorType: 'human',
      actorId: personA,
    });
    return { scope, intentId: intent.id, planId: plan.id, personB };
  }

  const issue = async (s: Seeded, extra: Partial<IssueRunContract> = {}) =>
    (
      await issueRunContract(
        s.scope,
        {
          intentId: s.intentId,
          planId: s.planId,
          baseSha,
          agent: {
            id: '66666666-6666-4666-8666-666666666666',
            version: '1.4.0',
            instructionsSha256: SHA('c'),
            tools: ['editor', 'git'],
          },
          planTools: ['editor', 'git'],
          autonomyLevel: 'L2',
          maxBudgetUsd: '2',
          maxIterations: 40,
          maxDurationMin: 60,
          allowedModels: ['anthropic/claude-haiku-4-5-20251001'],
          egressAllowlist: ['litellm:4000'],
          triggeredBy: s.personB,
          ...extra,
        },
        { signer: signingKey },
      )
    ).envelope;

  /** What the worker does (C06): wrap the run's token for the runner. */
  const wrapToken = () =>
    worker.wrapping().wrap({ token: new Redacted(TOKEN) }, { ttlSeconds: 900 });

  const events = async (s: Seeded, runId: string) =>
    (await s.scope.runEvents.list(runId)).map((e) => [e.event_type, e.payload] as const);

  const leftovers = () => [docker.containers.size, docker.networks.size, docker.volumes.size];
  const workDirEmpty = () => fs.readdirSync(workDir).length === 0;

  it('provisions: verify, claim, clone at base_sha, sandbox, healthy, running (AC2)', async () => {
    const s = await seed();
    const envelope = await issue(s);
    const result = await provisionRun(deps, { envelope, wrappedGitToken: await wrapToken() });
    expect(result.ok).toBe(true);
    const runId = envelope.contract.run_id;
    const run = await s.scope.runs.getById(runId);
    expect(run).toMatchObject({ status: 'running' });
    expect(run?.started_at).toBeInstanceOf(Date);

    const recorded = await events(s, runId);
    expect(recorded.map(([type]) => type)).toEqual([
      'contract_issued',
      'contract_accepted',
      'workspace_prepared',
      'sandbox_created',
      'sandbox_ready',
    ]);
    expect(recorded[2]?.[1]).toMatchObject({ base_sha: baseSha });
    expect(recorded[3]?.[1]).toEqual({ image_sha256: DEFAULT_IMAGE.split('@sha256:')[1] });
    expect(JSON.stringify(recorded)).not.toContain(TOKEN);

    // The workspace went into the container before the start; the clone on disk is gone.
    const [container] = [...docker.containers.values()];
    expect(container?.archives).toEqual(['/workspace']);
    const upload = docker.calls.find((c) => c.method === 'PUT');
    expect(Buffer.isBuffer(upload?.body)).toBe(true);
    const tar = upload!.body as Buffer;
    expect(tar.includes(Buffer.from('refs/heads/agent/INT-'))).toBe(true);
    expect(tar.includes(Buffer.from(TOKEN))).toBe(false);
    expect(workDirEmpty()).toBe(true);
    expect(git.requests.every((r) => r.authorized && !r.url.includes(TOKEN))).toBe(true);

    // AC5 after the run: releaseSandbox removes everything and records it.
    await releaseSandbox(deps, s.scope.tenantId, runId, 'finished');
    expect(leftovers()).toEqual([0, 0, 0]);
    expect((await events(s, runId)).at(-1)).toEqual([
      'sandbox_removed',
      expect.objectContaining({ reason: 'finished' }),
    ]);
  });

  it('starts at most one sandbox for one contract, even when provisioned twice at once (AC3)', async () => {
    const s = await seed();
    const envelope = await issue(s);
    const results = await Promise.all([
      provisionRun(deps, { envelope, wrappedGitToken: await wrapToken() }),
      provisionRun(deps, { envelope, wrappedGitToken: await wrapToken() }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: 'run_not_startable' });
    expect(docker.calls.filter((c) => c.path === '/containers/create')).toHaveLength(1);
    await releaseSandbox(deps, s.scope.tenantId, envelope.contract.run_id, 'finished');
  });

  it('a wrapping token used by someone else stops the run: token_unavailable (QUESTIONS #44)', async () => {
    const s = await seed();
    const envelope = await issue(s);
    const wrapped = await wrapToken();
    await runner.wrapping().unwrap(wrapped); // the "thief"
    const gitRequests = git.requests.length;
    const result = await provisionRun(deps, { envelope, wrappedGitToken: wrapped });
    expect(result).toEqual({
      ok: false,
      reason: 'token_unavailable',
      runId: envelope.contract.run_id,
    });
    expect(await s.scope.runs.getById(envelope.contract.run_id)).toMatchObject({
      status: 'failed',
      stop_reason: 'token_unavailable',
    });
    expect(docker.calls).toEqual([]);
    expect(git.requests).toHaveLength(gitRequests); // no clone was attempted
  });

  it.each<[string, Partial<IssueRunContract>, () => void, string]>([
    [
      'an egress entry the runner cannot enforce',
      { egressAllowlist: ['github.com', 'litellm:4000'] },
      () => undefined,
      'egress_not_enforceable',
    ],
    [
      'a base commit that is not in the repository',
      { baseSha: 'f'.repeat(40) },
      () => undefined,
      'base_sha_not_found',
    ],
    [
      'an image without a health check',
      {},
      () => (docker.health = undefined),
      'image_has_no_healthcheck',
    ],
    ['an unhealthy sandbox', {}, () => (docker.health = 'unhealthy'), 'sandbox_unhealthy'],
    [
      'a Docker failure at the container start',
      {},
      () => docker.failures.set(/^POST \/containers\/[^/]+\/start$/, 500),
      'docker_error',
    ],
  ])('fails cleanly on %s (AC5)', async (_label, extra, arrange, reason) => {
    const s = await seed();
    const envelope = await issue(s, extra);
    arrange();
    const result = await provisionRun(deps, { envelope, wrappedGitToken: await wrapToken() });
    expect(result).toEqual({ ok: false, reason, runId: envelope.contract.run_id });
    expect(await s.scope.runs.getById(envelope.contract.run_id)).toMatchObject({
      status: 'failed',
      stop_reason: reason,
    });
    const types = (await events(s, envelope.contract.run_id)).map(([type]) => type);
    expect(types).toContain('provisioning_failed');
    expect(leftovers()).toEqual([0, 0, 0]);
    expect(workDirEmpty()).toBe(true);
  });

  it('a clone with a token the Git host refuses fails with clone_failed', async () => {
    const s = await seed();
    const envelope = await issue(s);
    const wrapped = await worker
      .wrapping()
      .wrap({ token: new Redacted('ghs_revoked') }, { ttlSeconds: 60 });
    const result = await provisionRun(deps, { envelope, wrappedGitToken: wrapped });
    expect(result).toMatchObject({ ok: false, reason: 'clone_failed' });
    expect(docker.calls).toEqual([]);
    expect(workDirEmpty()).toBe(true);
  });

  it('refuses a bad contract before claiming or unwrapping', async () => {
    const s = await seed();
    const envelope = await issue(s);
    const tampered = { ...envelope, contract: { ...envelope.contract, max_iterations: 999 } };
    const wrapped = await wrapToken();
    expect(
      await provisionRun(deps, { envelope: tampered, wrappedGitToken: wrapped }),
    ).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(await s.scope.runs.getById(envelope.contract.run_id)).toMatchObject({
      status: 'queued',
    });
    // The wrapping token was not used: the real provisioning still works with it.
    expect((await provisionRun(deps, { envelope, wrappedGitToken: wrapped })).ok).toBe(true);
    await releaseSandbox(deps, s.scope.tenantId, envelope.contract.run_id, 'finished');
  });
});
