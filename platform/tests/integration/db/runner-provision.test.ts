// D-08 C04 on PostgreSQL: the runner's provisioning flow (ADR-M25 §2.8) with stub Docker, stub
// OpenBao (Transit + response wrapping) and a stub Git host. Covers:
// - AC2: clone with the wrapped, single-use token; `agent/INT-…` at base_sha in the workspace;
// - AC3: one contract starts at most one sandbox (concurrent provisioning, QUESTIONS #35);
// - AC5: clean-up after a failure at each late step, and after the run (releaseSandbox);
// - QUESTIONS #44: a wrapping token used by someone else stops the run (`token_unavailable`);
// - run events and final run status for each outcome (coded payloads only);
// - the workspace reserved before the claim (ADR-M25 §2.8), the clean-up at start and the sweep
//   (AC5 after a crash), and the slot pool around provisioning (AC3).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { RunContractVerifier } from '@sdlc/contracts';
import { OpenBaoClient, Redacted, type TransitKey } from '@sdlc/secrets';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import {
  DockerClient,
  HeldRuns,
  provisionRun,
  reconcileOnStart,
  releaseSandbox,
  Runner,
  runLabels,
  runnerSettingsFromEnv,
  sweepOrphans,
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
import { seedAgent } from '../agent-seed.js';
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
  readonly agentId: string;
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
      held: new HeldRuns(),
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
    // A provisioned run keeps its clone until the runner releases it (C07); start empty.
    for (const entry of fs.readdirSync(workDir)) {
      fs.rmSync(path.join(workDir, entry), { recursive: true, force: true });
    }
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
    const agent = await seedAgent(scope, personA, { version: '1.4.0', tools: ['editor', 'git'] });
    return { scope, intentId: intent.id, planId: plan.id, personB, agentId: agent.id };
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
            id: s.agentId,
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
  const created = () => docker.trace.filter((c) => /^POST .*\/(create|start)$/.test(c));
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

    // The workspace went into the container before the start. The runner's clone stays for the
    // run's changes (C07), without the token; the caller removes it.
    const [container] = [...docker.containers.values()];
    expect(container?.archives).toEqual(['/workspace']);
    const upload = docker.calls.find((c) => c.method === 'PUT');
    expect(Buffer.isBuffer(upload?.body)).toBe(true);
    const tar = upload!.body as Buffer;
    expect(tar.includes(Buffer.from('refs/heads/agent/INT-'))).toBe(true);
    expect(tar.includes(Buffer.from(TOKEN))).toBe(false);
    if (!result.ok) return;
    expect(fs.readdirSync(workDir)).toEqual([path.basename(result.cloneDir)]);
    const gitConfig = fs.readFileSync(path.join(result.cloneDir, 'repo', '.git', 'config'), 'utf8');
    expect(gitConfig).not.toContain(TOKEN);
    fs.rmSync(result.cloneDir, { recursive: true, force: true });
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
    expect(docker.calls.filter((c) => c.path === '/volumes/create')).toHaveLength(1);
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
    // Only the workspace reserved before the claim was created, and it is gone again.
    expect(created()).toEqual(['POST /volumes/create']);
    expect(leftovers()).toEqual([0, 0, 0]);
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
    expect(created()).toEqual(['POST /volumes/create']);
    expect(leftovers()).toEqual([0, 0, 0]);
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

  // ---------------------------------------------------------------- reserve, reconcile, sweep --

  const labelsOf = (s: Seeded, runId: string, instance = settings.instance) =>
    runLabels(instance, runId, s.scope.tenantId);

  it('a contract whose run already left `queued` is refused before any Docker call (D3)', async () => {
    const s = await seed();
    const envelope = await issue(s);
    const runId = envelope.contract.run_id;
    await s.scope.runs.claimForProvisioning(runId, new Date()); // another runner claimed it
    const result = await provisionRun(deps, { envelope, wrappedGitToken: await wrapToken() });
    expect(result).toMatchObject({ ok: false, reason: 'run_not_startable' });
    expect(docker.calls).toEqual([]);
    expect(deps.held.has(runId)).toBe(false);
  });

  it('a second provisioning of a run this process holds is refused before Docker (D3)', async () => {
    const s = await seed();
    const envelope = await issue(s);
    const runId = envelope.contract.run_id;
    deps.held.hold(runId);
    try {
      const result = await provisionRun(deps, { envelope, wrappedGitToken: await wrapToken() });
      expect(result).toMatchObject({ ok: false, reason: 'run_not_startable' });
      expect(docker.calls).toEqual([]);
      expect(await s.scope.runs.getById(runId)).toMatchObject({ status: 'queued' });
    } finally {
      deps.held.release(runId);
    }
  });

  it('reserves the workspace before the claim: a claimed run always has a labelled object (D3)', async () => {
    const s = await seed();
    const envelope = await issue(s);
    const runId = envelope.contract.run_id;
    docker.failures.set(/^POST \/networks\/create$/, 500); // stop right after the clone
    const result = await provisionRun(deps, { envelope, wrappedGitToken: await wrapToken() });
    expect(result).toMatchObject({ ok: false, reason: 'docker_error' });
    const order = docker.trace.filter((c) => c.startsWith('POST'));
    expect(order[0]).toBe('POST /volumes/create'); // before the clone and the network
    expect(docker.calls.find((c) => c.path === '/volumes/create')?.body).toMatchObject({
      Labels: labelsOf(s, runId),
    });
    expect(leftovers()).toEqual([0, 0, 0]);
  });

  it('cleans up after a restart: fails active runs, keeps other instances and queued runs (AC5)', async () => {
    const s = await seed();
    // A run that was running when the old process died.
    const running = await issue(s);
    const runningId = running.contract.run_id;
    expect(
      (await provisionRun(deps, { envelope: running, wrappedGitToken: await wrapToken() })).ok,
    ).toBe(true);
    // A run that finished, whose objects were left behind.
    const done = await issue(s);
    const doneId = done.contract.run_id;
    expect(
      (await provisionRun(deps, { envelope: done, wrappedGitToken: await wrapToken() })).ok,
    ).toBe(true);
    await s.scope.runs.transition(doneId, { from: ['running'], to: 'succeeded', now: new Date() });
    // A run whose workspace was reserved just before the crash; the claim never happened.
    const queued = await issue(s);
    const queuedId = queued.contract.run_id;
    docker.volumes.set(`sdlc-ws-${queuedId}`, labelsOf(s, queuedId));
    // Another runner deployment on the same Docker host.
    const foreign = '77777777-7777-4777-8777-777777777777';
    docker.volumes.set(`sdlc-ws-${foreign}`, labelsOf(s, foreign, 'staging'));
    // A clone the old process left on disk.
    fs.mkdirSync(path.join(workDir, 'run-old'));

    // New process: fresh held set, nothing in memory.
    const fresh = { ...deps, held: new HeldRuns() };
    const result = await reconcileOnStart(fresh);
    expect(result).toEqual({ runs: 3, failedRuns: 1, errors: 0 });

    expect(await s.scope.runs.getById(runningId)).toMatchObject({
      status: 'failed',
      stop_reason: 'runner_restarted',
    });
    expect((await events(s, runningId)).slice(-2)).toEqual([
      ['run_abandoned', { previous_status: 'running' }],
      ['sandbox_removed', expect.objectContaining({ reason: 'runner_restarted' })],
    ]);
    expect(await s.scope.runs.getById(doneId)).toMatchObject({ status: 'succeeded' });
    expect((await events(s, doneId)).at(-1)).toEqual([
      'sandbox_removed',
      expect.objectContaining({ reason: 'orphan' }),
    ]);
    expect(await s.scope.runs.getById(queuedId)).toMatchObject({ status: 'queued' });
    expect((await events(s, queuedId)).map(([type]) => type)).toEqual(['contract_issued']);

    expect(docker.containers.size).toBe(0);
    expect(docker.networks.size).toBe(0);
    expect([...docker.volumes.keys()]).toEqual([`sdlc-ws-${foreign}`]); // never touched
    expect(fs.existsSync(path.join(workDir, 'run-old'))).toBe(false);
    docker.volumes.clear();
  });

  it('sweeps orphans but never a held run; a lost active run ends as failed (AC5)', async () => {
    const s = await seed();
    const held = await issue(s);
    const heldId = held.contract.run_id;
    expect(
      (await provisionRun(deps, { envelope: held, wrappedGitToken: await wrapToken() })).ok,
    ).toBe(true);
    const lost = await issue(s);
    const lostId = lost.contract.run_id;
    const other = { ...deps, held: new HeldRuns() }; // "another" holder: lost is not in deps.held
    expect(
      (await provisionRun(other, { envelope: lost, wrappedGitToken: await wrapToken() })).ok,
    ).toBe(true);

    expect(await sweepOrphans(deps, deps.held)).toEqual({ runs: 1, failedRuns: 1, errors: 0 });
    expect(await s.scope.runs.getById(heldId)).toMatchObject({ status: 'running' });
    expect(await s.scope.runs.getById(lostId)).toMatchObject({
      status: 'failed',
      stop_reason: 'sandbox_lost',
    });
    expect((await events(s, lostId)).slice(-2)).toEqual([
      ['run_abandoned', { previous_status: 'running' }],
      ['sandbox_removed', expect.objectContaining({ reason: 'orphan' })],
    ]);
    expect(docker.containers.size).toBe(1); // the held run's sandbox
    await releaseSandbox(deps, s.scope.tenantId, heldId, 'finished');
    expect(leftovers()).toEqual([0, 0, 0]);
  });

  it('a clean-up error on one run does not stop the others', async () => {
    const s = await seed();
    const a = await issue(s);
    const b = await issue(s);
    for (const e of [a, b]) {
      const r = await provisionRun(
        { ...deps, held: new HeldRuns() },
        {
          envelope: e,
          wrappedGitToken: await wrapToken(),
        },
      );
      expect(r.ok).toBe(true);
    }
    docker.failures.set(new RegExp(`^DELETE /containers/sdlc-sandbox-${a.contract.run_id}$`), 500);
    const result = await reconcileOnStart(deps);
    expect(result).toEqual({ runs: 2, failedRuns: 1, errors: 1 });
    expect(await s.scope.runs.getById(b.contract.run_id)).toMatchObject({ status: 'failed' });
    docker.failures.clear();
    expect(await reconcileOnStart(deps)).toMatchObject({ errors: 0 });
    expect(leftovers()).toEqual([0, 0, 0]);
  });

  it('limits concurrent sandboxes: the second run waits for the first to be released (AC3)', async () => {
    const s = await seed();
    const pooled = new Runner({ ...deps, settings: { ...settings, maxSandboxes: 1 } });
    const first = await issue(s);
    const second = await issue(s);
    const failing = await issue(s, { egressAllowlist: ['github.com'] });

    // A failed provisioning frees its slot at once.
    expect(
      await pooled.provision({ envelope: failing, wrappedGitToken: await wrapToken() }),
    ).toMatchObject({ ok: false, reason: 'egress_not_enforceable' });
    expect(pooled.pool.active).toBe(0);

    expect(
      (await pooled.provision({ envelope: first, wrappedGitToken: await wrapToken() })).ok,
    ).toBe(true);
    let secondDone = false;
    const waiting = pooled
      .provision({ envelope: second, wrappedGitToken: await wrapToken() })
      .then((r) => ((secondDone = true), r));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondDone).toBe(false);
    expect(pooled.pool.waiting).toBe(1);
    expect(docker.containers.size).toBe(1);

    await pooled.release(s.scope.tenantId, first.contract.run_id, 'finished');
    expect((await waiting).ok).toBe(true);
    expect(docker.containers.size).toBe(1);
    await pooled.release(s.scope.tenantId, second.contract.run_id, 'finished');
    expect(pooled.pool.active).toBe(0);
    expect(pooled.held.size).toBe(0);
    expect(leftovers()).toEqual([0, 0, 0]);
  });
});
