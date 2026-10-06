// The G1–G6 stack on the sample repository's shape, for the C09 integration suite (D-08 C09,
// D-09 §7). B10's stack (`workflow/g1-g3/stack.ts`: the CLI, the API, the poller, the intent
// workflow on the Temporal test server) with what G4–G6 need, all real except the model:
// - the repository: a bare Git repository on a local Git host (`StubGitHost`, git's own smart-HTTP
//   server, `main` protected like branch protection) with the pilot's `AGENTS.md` and specs
//   (snapshots of `harryforge/pilot-order-inventory` at PILOT_COMMIT); the GitHub API stub answers
//   refs, contents and trees from the same repository, and pull requests, a `ci-ok` check run the
//   test controls, code scanning (no alert) and token revocation;
// - the worker's G4–G7 activities with the real `CostController` over a gateway that registers
//   each run key at the stub model, `StubOpenBao` (Transit signing, single-use wrapping);
// - the real runner as a Temporal worker on `sdlc-runner`: `Runner` with Docker, the node24
//   sandbox, the OpenHands Agent Server, the stub model as LiteLLM (no provider, no real key), its
//   spend check, the run's diff and L1 proposals in an in-memory evidence store, the push.
// The clock is the wall clock (the runner checks the Run Contract's times against it); the HOTL
// block window is one minute in the pilot configuration.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { OpenHandsAdapter } from '@sdlc/adapter-agent-openhands';
import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { LiteLLMKeySpendReader } from '@sdlc/adapter-model-litellm';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { OpenBaoClient } from '@sdlc/secrets';
import { Worker } from '@temporalio/worker';

import { createRunnerActivities } from '../../../apps/runner/src/activities.js';
import {
  DockerClient,
  Runner,
  runnerSettingsFromEnv,
  type RunnerSettings,
} from '../../../apps/runner/src/index.js';
import type { IntentActivityDeps } from '../../../apps/worker/src/activities/intent-activities.js';
import { RUNNER_TASK_QUEUE } from '../../../packages/contracts/src/index.js';
import { CostController } from '../../../packages/core/src/cost/controller.js';
import type { Intent, Run } from '../../../packages/core/src/db/schema.js';
import type { G4Deps } from '../../../packages/core/src/workflow/g4-proposal.js';
import { StubGitHost } from '../../runner/stub-git.js';
import { credentialFiles, StubOpenBao } from '../../secrets/stub-openbao.js';
import { NODE_IMAGE } from '../agent/helpers.js';
import { docker, dockerSocket, quietly } from '../runner/live-helpers.js';
import { buildSandboxImage } from '../sandbox-image/helpers.js';
import { repoRoot } from '../../workspace/helpers.js';
import {
  OWNER,
  PEOPLE,
  REPO_PATH,
  Stack,
  waitFor,
  type Person,
  type StackOptions,
} from '../workflow/g1-g3/stack.js';
import { BareRepo, MemoryBucket, MODEL, REPO_FULL, StubGateway, type StubCall } from './world.js';

/** The pilot commit the fixtures were copied from (`fixtures/`). */
export const PILOT_COMMIT = 'b9d7d739226700327cd1118395cb21be529346e6';
export const FIXTURES = path.join(repoRoot(), 'platform/tests/integration/pilot/fixtures');
export const SPECS = {
  T01: 'docs/specs/T01-product-list-japanese-labels.md',
  T09: 'docs/specs/T09-multiple-warehouses.md',
  T10: 'docs/specs/T10-delete-old-orders.md',
} as const;
export const AGENT_KEY = 'pilot-coder';
/** The path the stub's `[stub:append]` script writes (inside the T01 plan). */
export const NOTES_FILE = 'apps/web/src/features/products/NOTES.md';
export const T01_PATHS = ['apps/web/src/features/products/**'];
const HERE = path.join(repoRoot(), 'platform/tests/integration');

/** The pilot's files at PILOT_COMMIT that the suite needs, plus a README. */
export function pilotFiles(): Record<string, string> {
  const read = (file: string) => fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  return {
    'README.md': '# pilot-order-inventory (C09 fixture)\n',
    'AGENTS.md': read('AGENTS.md'),
    ...Object.fromEntries(Object.values(SPECS).map((spec) => [spec, read(spec)])),
  };
}

// --- The pilot stack ---------------------------------------------------------------------------

export interface PilotOptions {
  /** Extra project configuration lines (YAML), merged into the pilot configuration. */
  readonly config?: string;
  /**
   * The live test (`pilot-live.test.ts`): the real GitHub through the test App and the real
   * pilot repository, instead of the GitHub stub and the local Git host. `agentsMd` is the
   * repository's `AGENTS.md` at the head of `main` (the agent is registered with its hash).
   */
  readonly live?: {
    readonly gitHost: GitHubAdapter;
    readonly repoFullName: string;
    readonly agentsMd: string;
    /** E07 live G8: Person B's real GitHub account (reviews and merges the pull request). */
    readonly githubAccounts?: StackOptions['githubAccounts'];
  };
}

interface PullState {
  readonly number: number;
  readonly head: string;
  state: 'open' | 'closed';
  /** E07: the reviews submitted on the pull request (GitHub REST shape). */
  readonly reviews: object[];
  /** E07: set when a person merged it on the Git host. */
  merged?: { readonly sha: string; readonly by: Person; readonly at: string };
}

/** E07: the release pack reads stored evidence back up to this size (worker default 256 MB). */
const RELEASE_MAX_ITEM_BYTES = 256 * 1024 * 1024;

export type CiResult = 'pending' | 'success' | 'failure';

export class PilotStack extends Stack {
  repo!: BareRepo;
  git!: StubGitHost;
  gateway!: StubGateway;
  readonly bucket = new MemoryBucket();
  runnerSettings!: RunnerSettings;
  dockerClient!: DockerClient;
  readonly #suffix = crypto.randomBytes(4).toString('hex');
  readonly #names = {
    platformNet: `sdlc-c09-platform-${this.#suffix}`,
    model: `sdlc-c09-litellm-${this.#suffix}`,
    relay: `sdlc-c09-relay-${this.#suffix}`,
    registry: `sdlc-c09-registry-${this.#suffix}`,
  };
  readonly #adminKey = crypto.randomBytes(24).toString('hex');
  readonly #pulls: PullState[] = [];
  /** CI of each commit; `ci-ok` is pending until the test sets it. */
  readonly ci = new Map<string, CiResult>();
  readonly #revokedTokens = new Set<string>();
  #bao: StubOpenBao | undefined;
  #baoFiles: ReturnType<typeof credentialFiles> | undefined;
  #clients: OpenBaoClient[] = [];
  #runner: Runner | undefined;
  #runnerWorker: Worker | undefined;
  #runnerRunning: Promise<void> | undefined;
  #modelUrl = '';
  image = '';

  async startPilot(options: PilotOptions = {}): Promise<void> {
    const live = options.live;
    if (!live) {
      this.git = await StubGitHost.start(crypto.randomBytes(16).toString('hex'));
      this.repo = new BareRepo(this.git, pilotFiles());
    }
    this.#startDocker();
    this.image = process.env.SDLC_SANDBOX_IMAGE || (await buildSandboxImage(this.#names.registry));
    this.#bao = await StubOpenBao.start();
    this.#baoFiles = credentialFiles();
    const bao = () => {
      const client = new OpenBaoClient({
        address: this.#bao!.address,
        allowPlaintext: true,
        roleIdFile: this.#baoFiles!.roleIdFile,
        secretIdFile: this.#baoFiles!.secretIdFile,
      });
      this.#clients.push(client);
      return client;
    };
    const workerBao = bao();
    const runnerBao = bao();
    this.gateway = new StubGateway(
      (method, body) => this.#modelAdmin(method, body),
      () => this.#modelCalls(),
    );

    await this.start({
      ...(live
        ? {
            live: { gitHost: live.gitHost, repoFullName: live.repoFullName },
            ...(live.githubAccounts ? { githubAccounts: live.githubAccounts } : {}),
          }
        : { repo: this.repo }),
      clock: 'real',
      projectConfig: this.#projectConfig(options.config ?? ''),
      activities: ({ gitHost, registry }) => {
        const costController = new CostController({ gateway: this.gateway, db: this.db.app });
        const g4: G4Deps = {
          gitHost,
          allowedModels: async (config, dataClass) =>
            createSimplePolicyEngine({
              config,
              models: await this.gateway.listModels(),
            }).allowedModels({ dataClass }),
        };
        return {
          g4,
          runs: {
            registry,
            g4,
            signer: workerBao.transit(),
            costController,
            gitHost,
            wrapper: workerBao.wrapping(),
            egressAllowlist: ['litellm:4000'],
          },
          publish: { registry, gitHost, wrapper: workerBao.wrapping() },
          g6: { gitHost },
          g7: { gitHost },
          // E03 / E07: the worker's evidence store for G8's release pack (`packs/`; it reads the
          // stored proposals and diffs back to check them).
          releases: { store: this.bucket.store('packs/'), maxItemBytes: RELEASE_MAX_ITEM_BYTES },
        } as unknown as Partial<IntentActivityDeps>;
      },
    });
    if (!live) {
      this.#routePilot();
      this.git.acceptToken = (token) =>
        !this.#revokedTokens.has(token) &&
        this.github.stub.issuedTokens.some((issued) => issued.token === token);
    }
    await this.#startRunner(runnerBao, live !== undefined);
    let agentsFile = path.join(FIXTURES, 'AGENTS.md');
    if (live) {
      agentsFile = path.join(this.home, 'AGENTS.md');
      fs.writeFileSync(agentsFile, live.agentsMd);
    }
    await this.#registerAgent(agentsFile);
  }

  async stopPilot(): Promise<void> {
    this.#runnerWorker?.shutdown();
    await this.#runnerRunning?.catch(() => undefined);
    await this.#runner?.stop();
    for (const id of docker(
      'ps',
      '-a',
      '-q',
      '--filter',
      `label=sdlc.runner-instance=${this.#instance}`,
    )
      .split('\n')
      .filter((line) => line !== '')) {
      quietly('rm', '-f', '-v', id);
    }
    quietly('rm', '-f', this.#names.model, this.#names.relay, this.#names.registry);
    quietly('network', 'rm', this.#names.platformNet);
    await this.stop();
    for (const client of this.#clients) await client.close();
    await this.#bao?.stop();
    if (this.git) await this.git.stop();
    if (this.#baoFiles) fs.rmSync(this.#baoFiles.dir, { recursive: true, force: true });
  }

  get #instance(): string {
    return `c09-${this.#suffix}`;
  }

  /** `run` lines go into the `run:` mapping (two spaces in, like `agent_key`). */
  #projectConfig(extra: string, run: readonly string[] = []): string {
    return [
      'access:',
      '  plan_submit_roles: [person_a, person_b]',
      'oversight:',
      '  hotl_block_window: { value: 1, unit: minutes }',
      'run:',
      `  agent_key: ${AGENT_KEY}`,
      '  g6_ci_retries: 1',
      ...run.map((line) => `  ${line}`),
      'verification:',
      '  required_checks: [ci-ok]',
      'sandbox:',
      `  image: ${this.image}`,
      extra,
    ].join('\n');
  }

  // --- Docker ----------------------------------------------------------------------------------

  #startDocker(): void {
    docker('pull', '-q', NODE_IMAGE);
    docker('network', 'create', this.#names.platformNet);
    const common = ['--network', this.#names.platformNet, '--read-only', '--cap-drop', 'ALL'];
    docker(
      'run',
      '-d',
      '--name',
      this.#names.model,
      ...common,
      '--user',
      '1000:1000',
      '-p',
      '127.0.0.1::4000',
      '-e',
      `STUB_ADMIN_KEY=${this.#adminKey}`,
      '-v',
      `${path.join(HERE, 'agent/stub-model.mjs')}:/stub/stub-model.mjs:ro`,
      NODE_IMAGE,
      'node',
      '/stub/stub-model.mjs',
    );
    const modelPort = docker('port', this.#names.model, '4000/tcp')
      .split('\n')[0]!
      .split(':')
      .pop()!;
    this.#modelUrl = `http://127.0.0.1:${modelPort}`;
    // The relay stands in for the runner's own container (SDLC_RUNNER_SELF_CONTAINER).
    docker(
      'run',
      '-d',
      '--name',
      this.#names.relay,
      ...common,
      '--user',
      '1000:1000',
      '-p',
      '127.0.0.1::8000',
      '-v',
      `${path.join(HERE, 'pilot/relay-http.mjs')}:/relay/relay.mjs:ro`,
      NODE_IMAGE,
      'node',
      '/relay/relay.mjs',
    );
  }

  /** Registers or revokes a run key at the stub model (the gateway's admin call). */
  async #modelAdmin(method: 'POST' | 'DELETE', body: object): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${this.#modelUrl}/test/keys`, {
          method,
          headers: {
            authorization: `Bearer ${this.#adminKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (res.ok) return;
        throw new Error(`stub model: HTTP ${String(res.status)}`);
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  /** E07: every call the stub model counted for a registered run key. */
  async #modelCalls(): Promise<readonly StubCall[]> {
    const res = await fetch(`${this.#modelUrl}/test/calls`, {
      headers: { authorization: `Bearer ${this.#adminKey}` },
    });
    if (!res.ok) throw new Error(`stub model: HTTP ${String(res.status)}`);
    return ((await res.json()) as { calls: StubCall[] }).calls;
  }

  /** E07: how many calls the stub model counted for the registered run keys. */
  async modelCallCount(): Promise<number> {
    return (await this.#modelCalls()).length;
  }

  /** The stub model's log lines (`stub:call:…`, `stub:check:…`, never a content). */
  modelLogs(): string {
    return docker('logs', this.#names.model);
  }

  // --- The runner ------------------------------------------------------------------------------

  async #startRunner(runnerBao: OpenBaoClient, live: boolean): Promise<void> {
    const relayPort = docker('port', this.#names.relay, '8000/tcp')
      .split('\n')[0]!
      .split(':')
      .pop()!;
    const workDir = fs.mkdtempSync(path.join(this.home, 'runner-'));
    this.runnerSettings = runnerSettingsFromEnv({
      SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
      SDLC_RUNNER_INSTANCE: this.#instance,
      SDLC_RUNNER_MAX_SANDBOXES: '1',
      SDLC_RUNNER_EGRESS_SERVICES: `litellm=${this.#names.model}:4000`,
      ...(live
        ? {}
        : { SDLC_RUNNER_GIT_BASE_URL: this.git.origin, SDLC_RUNNER_GIT_ALLOW_PLAINTEXT: '1' }),
      SDLC_RUNNER_WORK_DIR: workDir,
      SDLC_RUNNER_READY_TIMEOUT_SECONDS: '180',
      SDLC_RUNNER_SELF_CONTAINER: this.#names.relay,
      SDLC_RUNNER_AGENT_POLL_MS: '250',
      SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS: '30',
    });
    this.dockerClient = new DockerClient({ socketPath: dockerSocket(), timeoutMs: 120_000 });
    // Token-only, like the runner process (it never reads the GitHub App key).
    const tokenAdapter = new GitHubAdapter({
      ...(live ? {} : { apiUrl: this.github.stub.address, allowPlaintext: true }),
      secrets: { read: () => Promise.reject(new Error('the runner holds no GitHub App key')) },
    });
    const transit = runnerBao.transit();
    const spendReader = new LiteLLMKeySpendReader({ baseUrl: this.#modelUrl });
    const diffs = this.bucket.store('diffs/');
    this.#runner = new Runner(
      {
        db: this.db.app as unknown as ConstructorParameters<typeof Runner>[0]['db'],
        docker: this.dockerClient,
        settings: this.runnerSettings,
        verifier: transit,
        unwrapper: runnerBao.wrapping(),
        tokenRevoker: tokenAdapter,
        feedbackReader: tokenAdapter,
      },
      {},
      {
        adapter: new OpenHandsAdapter(),
        agentUrl: (runId) => `http://127.0.0.1:${relayPort}/run/${runId}`,
        evidence: this.bucket.store('proposals/'),
        diffEvidence: diffs,
        spendReader,
        keyRevoked: (key) => spendReader.keyRevoked(key),
      },
    );
    await this.#runner.start();
    this.#runnerWorker = await Worker.create({
      connection: this.env.nativeConnection,
      namespace: this.env.namespace ?? 'default',
      taskQueue: RUNNER_TASK_QUEUE,
      activities: createRunnerActivities({
        db: this.db.app as unknown as Parameters<typeof createRunnerActivities>[0]['db'],
        runner: this.#runner,
        unwrapper: runnerBao.wrapping(),
        publish: { settings: this.runnerSettings, diffEvidence: diffs, tokenRevoker: tokenAdapter },
      }),
      maxConcurrentActivityTaskExecutions: 1,
    });
    this.#runnerRunning = this.#runnerWorker.run();
  }

  /**
   * B13 / handbook Ch.20: the tenant admin registers the agent with the SHA-256 of the pilot's
   * `AGENTS.md`; its owner (Person A) and Person B approve it for use.
   */
  async #registerAgent(agentsFile: string): Promise<void> {
    await this.cliJson('admin', [
      'admin',
      'agent',
      'register',
      '--key',
      AGENT_KEY,
      '--version',
      '1.0.0',
      '--owner',
      'a@acme.test',
      '--model',
      MODEL,
      '--instructions',
      'AGENTS.md@pilot',
      '--instructions-file',
      agentsFile,
      '--tools',
      'file_editor,terminal',
      '--max-autonomy',
      'L2',
      '--environments',
      'sandbox',
    ]);
    await this.cliJson('a', [
      'admin',
      'agent',
      'approve',
      '--key',
      AGENT_KEY,
      '--purpose',
      'activate',
      '--as',
      'owner',
    ]);
    await this.cliJson('b', [
      'admin',
      'agent',
      'approve',
      '--key',
      AGENT_KEY,
      '--purpose',
      'activate',
      '--as',
      'person_b',
    ]);
  }

  // --- GitHub: pull requests, CI, code scanning, token revocation -----------------------------

  #routePilot(): void {
    const stub = this.github.stub;
    const prPath = (n: number) => `${REPO_PATH}/pulls/${String(n)}`;
    stub.on('GET', `${REPO_PATH}/pulls`, (req) => {
      const head = req.query.get('head');
      const state = req.query.get('state') ?? 'open';
      return {
        body: this.#pulls
          .filter((p) => state === 'all' || p.state === state)
          .filter((p) => head === null || `${OWNER}:${p.head}` === head)
          .map((p) => this.#pullJson(p)),
      };
    });
    stub.on('POST', `${REPO_PATH}/pulls`, (req) => {
      const body = req.body as { head: string; base: string };
      const pull: PullState = {
        number: 300 + this.#pulls.length,
        head: body.head,
        state: 'open',
        reviews: [],
      };
      this.#pulls.push(pull);
      stub.on('GET', prPath(pull.number), () => ({ body: this.#pullJson(pull) }));
      stub.on('GET', `${prPath(pull.number)}/reviews`, () => ({ body: pull.reviews }));
      // The agent branch has one commit, by `sdlc-agent`: no GitHub account (QUESTIONS #80).
      stub.on('GET', `${prPath(pull.number)}/commits`, () => ({
        body: [{ sha: this.repo.head(pull.head), author: null }],
      }));
      return { status: 201, body: this.#pullJson(pull) };
    });
    stub.on('GET', `${REPO_PATH}/code-scanning/alerts`, { body: [] });
    stub.on('DELETE', '/installation/token', (req) => {
      this.#revokedTokens.add(String(req.headers.authorization).replace(/^Bearer /, ''));
      return { status: 204 };
    });
    stub.fallback = (req) => {
      const fromRepo = this.repo.answer(req);
      if (fromRepo) return fromRepo;
      const checks = new RegExp(`^${REPO_PATH}/commits/([0-9a-f]{40})/(check-runs|status)$`).exec(
        req.path,
      );
      if (req.method === 'GET' && checks) {
        const sha = checks[1]!;
        if (checks[2] === 'status') return { body: { state: 'pending', statuses: [] } };
        const result = this.ci.get(sha) ?? 'pending';
        return {
          body: {
            total_count: 1,
            check_runs: [
              {
                // Each check run has its own ID on GitHub (the poller's receipts key on it).
                id: this.#checkRunId(sha, result),
                name: 'ci-ok',
                head_sha: sha,
                status: result === 'pending' ? 'in_progress' : 'completed',
                conclusion: result === 'pending' ? null : result,
                completed_at: result === 'pending' ? null : new Date().toISOString(),
                html_url: `https://github.com/${REPO_FULL}/runs/7000`,
              },
            ],
          },
        };
      }
      return { status: 404, body: { message: 'Not Found' } };
    };
  }

  readonly #checkRunIds = new Map<string, number>();

  #checkRunId(sha: string, result: CiResult): number {
    const key = `${sha}:${result}`;
    if (!this.#checkRunIds.has(key)) this.#checkRunIds.set(key, 7001 + this.#checkRunIds.size);
    return this.#checkRunIds.get(key)!;
  }

  #pullJson(p: PullState) {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    return {
      number: p.number,
      state: p.state,
      draft: false,
      html_url: `https://github.com/${REPO_FULL}/pull/${String(p.number)}`,
      user: { id: 9100, login: 'harryforge-sdlc-dev[bot]', type: 'Bot', node_id: 'B_9100' },
      head: { sha: this.repo.head(p.head), ref: p.head },
      base: { sha: this.repo.head(), ref: 'main' },
      merged_at: p.merged?.at ?? null,
      closed_at: p.merged?.at ?? null,
      merge_commit_sha: p.merged?.sha ?? null,
      merged_by: p.merged ? ghUser(p.merged.by) : null,
      changed_files: 1,
      updated_at: now,
      created_at: now,
      title: 'fixed',
      body: 'fixed',
    };
  }

  /**
   * E07: `who` submits a review of the pull request's current head on GitHub (`APPROVED` or
   * `CHANGES_REQUESTED`), then the poller runs (the `review_submitted` wake).
   */
  async review(
    intent: Pick<Intent, 'pr_number'>,
    who: Person,
    state: 'APPROVED' | 'CHANGES_REQUESTED',
  ): Promise<void> {
    const pull = this.#pull(intent);
    pull.reviews.push({
      id: 8100 + pull.reviews.length,
      user: ghUser(who),
      state,
      commit_id: this.repo.head(pull.head),
      submitted_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      html_url: `https://github.com/${REPO_FULL}/pull/${String(pull.number)}#review`,
    });
    await this.poll();
  }

  /**
   * E07: `who` merges the pull request on the Git host (a merge commit on `main`), as a person
   * does on GitHub; then the poller runs (the `pull_request_closed` wake). The platform never
   * merges: the suite checks that it never called a merge endpoint.
   */
  async mergeAsPerson(intent: Pick<Intent, 'pr_number'>, who: Person): Promise<string> {
    const pull = this.#pull(intent);
    const sha = this.repo.merge(pull.head);
    pull.state = 'closed';
    pull.merged = { sha, by: who, at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    await this.poll();
    return sha;
  }

  #pull(intent: Pick<Intent, 'pr_number'>): PullState {
    const pull = this.#pulls.find((p) => p.number === intent.pr_number);
    if (!pull) throw new Error('no pull request');
    return pull;
  }

  /** Bodies of the pull requests the platform opened. */
  openedPulls(): { title: string; body: string; head: string; base: string }[] {
    return this.github.stub
      .requestsTo('POST', `${REPO_PATH}/pulls`)
      .map((r) => r.body as { title: string; body: string; head: string; base: string });
  }

  /** Sets `ci-ok` of the agent branch's current head, then polls (the `check_completed` wake). */
  async setCi(intent: Pick<Intent, 'code'>, result: CiResult): Promise<void> {
    const head = this.repo.head(`agent/${intent.code}`);
    if (!head) throw new Error('no agent branch');
    this.ci.set(head, result);
    await this.poll();
  }

  /** The token revocations the runner made (`DELETE /installation/token`). */
  revokedTokenCount(): number {
    return this.#revokedTokens.size;
  }

  // --- Driving intents through the public entry points ----------------------------------------

  /**
   * A new intent through G1–G3 by people's decisions on the CLI (HITL at Medium and above; at Low
   * G2 and G3 pass by HOTL). Returns once G3 is decided; the workflow then evaluates G4.
   */
  async throughG3(
    risk: 'low' | 'medium' | 'high' | 'critical',
    plan: { specPath: string; paths: string[]; summary: string },
    extra: readonly string[] = [],
  ): Promise<Intent> {
    const intent = await this.createIntent(risk, extra);
    await this.atGate(intent, 'G1');
    await this.approve('a', 'G1', intent);
    await this.atGate(intent, 'G2');
    await this.linkInputs(intent, plan);
    if (risk === 'low') return intent;
    await this.approve(risk === 'medium' ? 'a' : 'b', 'G2', intent);
    await this.atGate(intent, 'G3');
    await this.approve('b', 'G3', intent);
    return intent;
  }

  /** `sdlc gate approve <gate> <INT>` as `who`. */
  async approve(who: 'a' | 'b', gate: string, intent: Pick<Intent, 'code'>): Promise<void> {
    await this.cliJson(who, ['gate', 'approve', gate, intent.code]);
  }

  /** The tenant admin uploads the pilot configuration with `extra` (`sdlc admin config set`). */
  async setConfig(
    extra: string,
    options: { agentKey?: string; run?: readonly string[] } = {},
  ): Promise<void> {
    const shown = await this.cliJson<{ version: number }>('admin', [
      'admin',
      'config',
      'show',
      '--project',
      'pilot',
    ]);
    const file = path.join(this.home, `config-${String(shown.version)}.yaml`);
    const yaml = this.#projectConfig(extra, options.run);
    fs.writeFileSync(
      file,
      options.agentKey === undefined
        ? yaml
        : yaml.replace(`agent_key: ${AGENT_KEY}`, `agent_key: ${options.agentKey}`),
    );
    await this.cliJson('admin', [
      'admin',
      'config',
      'set',
      '--project',
      'pilot',
      '--file',
      file,
      '--expected-version',
      String(shown.version),
    ]);
  }

  /** The causes of the intent's failed G4 checks (audit `gate.g4_check_failed`), in order. */
  async g4Checks(intent: Pick<Intent, 'id'>): Promise<string[]> {
    return (await this.scope.audit.listForEntity(intent.id, ['gate.g4_check_failed'])).map(
      (e) => (e.payload as { check: string }).check,
    );
  }

  // --- Reading the state -----------------------------------------------------------------------

  runs(intent: Pick<Intent, 'id'>): Promise<readonly Run[]> {
    return this.scope.runs.listForIntent(intent.id);
  }

  async runEvents(run: Pick<Run, 'id'>): Promise<string[]> {
    return (await this.scope.runEvents.list(run.id)).map((e) => e.event_type);
  }

  /** Waits until the intent is in `status` (at `gate` when given). */
  until(intent: Pick<Intent, 'id'>, status: string, gate?: string): Promise<Intent> {
    return waitLong(
      () => this.reload(intent),
      (i) => i.status === status && (gate === undefined || i.current_gate === gate),
    );
  }

  /** Waits until the intent has run number `n` (1-based) ended with a final status. */
  async runEnded(intent: Pick<Intent, 'id'>, n = 1): Promise<Run> {
    const runs = await waitLong(
      () => this.runs(intent),
      (list) => list.length >= n && FINAL.has(list[n - 1]!.status),
    );
    return runs[n - 1]!;
  }

  /** Docker objects of a run that are still there (sandbox, network, volume). */
  leftovers(runId: string): string[] {
    return [
      docker('ps', '-a', '-q', '--filter', `name=sdlc-sandbox-${runId}`),
      docker('network', 'ls', '-q', '--filter', `name=sdlc-run-${runId}`),
      docker('volume', 'ls', '-q', '--filter', `label=sdlc.run-id=${runId}`),
    ].filter((out) => out !== '');
  }
}

/** A person's GitHub account as the REST API shows it (numeric ID, PEOPLE). */
function ghUser(who: Person) {
  const p = PEOPLE[who];
  return { id: p.gh, login: p.login, type: 'User', node_id: `U_${String(p.gh)}` };
}

const FINAL = new Set([
  'succeeded',
  'succeeded_proposal_only',
  'failed',
  'stopped_budget',
  'stopped_scope',
  'stopped_timeout',
  'stopped_stalled',
  'stopped_killed',
  'cancelled',
]);

/** Like `waitFor`, for real runs (a sandbox and the agent take tens of seconds). */
export async function waitLong<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export { MODEL, sha256, STUB_PRICE_USD } from './world.js';
export { waitFor };
