// The whole G1–G3 stack in one process, for the integration tests of task B10 (D-08 B10, D-09 §7).
// Every action goes through a public entry point:
// - the `sdlc` CLI (operator commands on the database, user and admin commands through the API);
// - the API app (Nest + Fastify `inject()`, no port), which the CLI's `fetch` is routed to;
// - comment commands on the GitHub stub, read by the poller (`pollProject`) with the real adapter;
// - the intent workflow on the Temporal time-skipping server with the worker's real activities;
// - the worker's escalation clock loop and reconcile loop, ticked by the test.
// Core functions are used only to read the state the tests check. One clock drives the registry,
// the API, the GitHub stub and the escalation loop; `advance` also skips the same Temporal time.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';

import { createApp, type ApiDeps } from '../../../../apps/api/src/app.js';
import { processContext } from '../../../../apps/cli/src/context.js';
import { runCli, type CliContext } from '../../../../apps/cli/src/index.js';
import {
  createIntentActivities,
  type IntentActivityDeps,
} from '../../../../apps/worker/src/activities/intent-activities.js';
import {
  EscalationLoop,
  type EscalationLoopDeps,
} from '../../../../apps/worker/src/escalation-loop.js';
import { ReconcileLoop } from '../../../../apps/worker/src/reconcile-loop.js';
import {
  startIntentWorker,
  type IntentWorkerHandle,
} from '../../../../apps/worker/src/temporal.js';
import type { Escalation, Intent } from '../../../../packages/core/src/db/schema.js';
import type { PollableProject } from '../../../../packages/core/src/db/system-scope.js';
import { parseTenantId } from '../../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../../packages/core/src/db/tenant-scope.js';
import { advanceEscalation } from '../../../../packages/core/src/escalation/advance.js';
import { pollProject } from '../../../../packages/core/src/git-events/poll-project.js';
import { planPath } from '../../../../packages/core/src/plans/rules.js';
import { Registry } from '../../../../packages/core/src/registry/registry.js';
import { TemporalIntentSignals } from '../../../../packages/workflow-client/src/index.js';
import { startHarness, type Harness } from '../../../git-github/helpers.js';
import { comment, user } from '../../../git-github/stub-github.js';
import { createTestDatabase, urlFor, type TestDatabase } from '../../db/helpers.js';

const WORKFLOWS = path.resolve(__dirname, '../../../../apps/worker/dist/workflows/index.js');
const API_URL = 'https://sdlc.b10.test';
const OWNER = 'acme';
const REPO = 'pilot-order-inventory';
const REPO_PATH = `/repos/${OWNER}/${REPO}`;
export const PROJECT = 'pilot';
export const SPEC_PATH = 'docs/specs/T07.md';
export const SPEC_TEXT = '# T07 Cancel an order\nAC1: the stock returns.\n';

/** Monday 2026-09-28 10:00 in Asia/Ho_Chi_Minh (the default working calendar). */
export const T0 = new Date('2026-09-28T03:00:00.000Z');
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The people of the pilot project: role and numeric GitHub account ID (QUESTIONS #45). */
export const PEOPLE = {
  a: { role: 'person_a', gh: 4001, login: 'alice' },
  b: { role: 'person_b', gh: 4002, login: 'bob' },
  second: { role: 'second_approver', gh: 4003, login: 'sam' },
  gov: { role: 'governance', gh: 4004, login: 'gina' },
  viewer: { role: 'viewer', gh: 4005, login: 'vic' },
} as const;
export type Person = keyof typeof PEOPLE;

/**
 * The project configuration the tenant admin uploads (merged with the platform defaults). Person B
 * may submit plans too (rule M24 forbids only the viewer), so the N5 producer case can be checked.
 */
const PROJECT_CONFIG = 'access:\n  plan_submit_roles: [person_a, person_b]\n';

export interface CliResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface StackOptions {
  /** Skip `sdlc ai-record set` (AC6: the intents wait for the record). */
  readonly withoutAiRecord?: boolean;
}

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** Polls the database until `ok` (deterministic wait: no fixed sleep). */
export async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A plan file (template T13, schema version 1) with one task. */
export function planYaml(
  code: string,
  paths: readonly string[] = ['apps/api/src/orders/**'],
  changeFlags: readonly string[] = [],
): string {
  return [
    'plan:',
    `  intent_id: ${code}`,
    ...(changeFlags.length > 0 ? [`  change_flags: [${changeFlags.join(', ')}]`] : []),
    'tasks:',
    '  - id: T1',
    `    allowed_paths: [${paths.join(', ')}]`,
    '    tools: [file_editor, terminal]',
    '',
  ].join('\n');
}

export class Stack {
  readonly users = {} as Record<Person, string>;
  scope!: TenantScope;
  target!: PollableProject;
  env!: TestWorkflowEnvironment;
  signals!: TemporalIntentSignals;
  escalationLoop!: EscalationLoop;
  reconcileLoop!: ReconcileLoop;
  #db!: TestDatabase;
  #h!: Harness;
  #app!: Awaited<ReturnType<typeof createApp>>;
  #worker: IntentWorkerHandle | undefined;
  #registry!: Registry;
  #now = T0;
  readonly #tokens = {} as Record<Person | 'admin', string>;
  readonly #home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-b10-'));
  readonly #comments: ReturnType<typeof comment>[] = [];
  #commentId = 9000;
  #issue = 200;
  readonly #commits = new Map<string, Map<string, string>>();
  #head = '';
  #commitCount = 0;

  /** The shared clock (registry, API, GitHub stub, escalation loop). */
  now(): Date {
    return this.#now;
  }

  async start(options: StackOptions = {}): Promise<void> {
    this.#db = await createTestDatabase();
    this.#registry = new Registry({
      policyFactory: (config) => createSimplePolicyEngine({ config }),
      now: () => this.#now,
    });
    this.#h = await startHarness();
    this.#h.stub.now = T0;
    this.#routeGitHub();
    this.commit({ [SPEC_PATH]: SPEC_TEXT });
    const gitHost = this.#h.adapter();

    this.env = await TestWorkflowEnvironment.createTimeSkipping({
      server: {
        executable: { type: 'existing-path', path: process.env.SDLC_TEMPORAL_TEST_SERVER! },
      },
    });
    this.signals = new TemporalIntentSignals(this.env.client);
    this.#app = await createApp({
      db: this.#db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1_000 },
      now: () => this.#now,
      intentSignals: this.signals,
      gitHost,
      log: { log: () => undefined },
    });

    await this.#onboard(options);

    const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
    const bundlePath = path.join(this.#home, 'bundle.js');
    fs.writeFileSync(bundlePath, code);
    this.#worker = await startIntentWorker({
      settings: { address: this.env.address, namespace: this.env.namespace ?? 'default' },
      workflowBundlePath: bundlePath,
      activities: createIntentActivities({
        db: this.#db.app as unknown as IntentActivityDeps['db'],
        registry: this.#registry as unknown as IntentActivityDeps['registry'],
        specs: {
          gitHost: gitHost as unknown as NonNullable<IntentActivityDeps['specs']>['gitHost'],
        },
      }),
    });

    // The worker's two loops, built like `apps/worker/src/main.ts` builds them; ticked by the tests.
    // The worker is typed against the built `@sdlc/core`; the test database is the source class.
    const db = this.#db.app;
    const logger = { log: () => undefined };
    this.escalationLoop = new EscalationLoop({
      listDue: (now, limit) =>
        db.system.listDueEscalations(now, limit) as unknown as ReturnType<
          EscalationLoopDeps['listDue']
        >,
      advance: (due, now) =>
        advanceEscalation(db.forTenant(parseTenantId(due.tenantId)), due.escalationId, now),
      now: () => this.#now,
      logger,
      batchSize: 50,
    });
    this.reconcileLoop = new ReconcileLoop({
      listOpen: (limit, after) => db.system.listOpenIntents(limit, after),
      signals: this.signals,
      logger,
      batchSize: 50,
    });

    await this.poll(); // first poll of the project: no history
  }

  async stop(): Promise<void> {
    await this.#worker?.shutdown();
    await this.env?.teardown();
    await this.#app?.close();
    await this.#h?.stub.stop();
    await this.#db?.drop();
    fs.rmSync(this.#home, { recursive: true, force: true });
  }

  /**
   * Moves the shared clock. `temporal: true` also skips the same time on the Temporal test server,
   * so the workflow's timers fire; otherwise only the database-side clocks move (the escalation
   * loop, the approval expiry), as when the workflow is not woken.
   */
  async advanceTo(at: Date, options: { temporal: boolean }): Promise<void> {
    const ms = at.getTime() - this.#now.getTime();
    if (ms < 0) throw new Error('the clock never goes back');
    this.#now = at;
    this.#h.stub.now = at;
    if (options.temporal && ms > 0) await this.env.sleep(ms);
  }

  // --- The CLI -----------------------------------------------------------------------------------

  /** `sdlc …` as `person` (through the API), or the operator (`ops …`, on the database). */
  async cli(who: Person | 'admin' | 'operator', argv: readonly string[]): Promise<CliResult> {
    const out: string[] = [];
    const err: string[] = [];
    const env: Record<string, string> = { HOME: this.#home };
    if (who === 'operator') env.SDLC_DB_URL = urlFor(this.#db.name, 'platform_app');
    else {
      env.SDLC_API_URL = API_URL;
      env.SDLC_API_TOKEN = this.#tokens[who];
    }
    const ctx: CliContext = {
      env,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      connect: processContext().connect,
      api: {
        fetch: this.#fetch,
        readHiddenLine: () => Promise.resolve(''),
        readStdin: () => Promise.resolve(''),
        stdinIsTTY: false,
      },
    };
    const code = await runCli(argv, ctx);
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  /** Like `cli`, with `--json`; fails the test unless the command succeeds. */
  async cliJson<T = Record<string, unknown>>(
    who: Person | 'admin' | 'operator',
    argv: readonly string[],
  ): Promise<T> {
    const result = await this.cli(who, [...argv, '--json']);
    if (result.code !== 0) {
      throw new Error(`sdlc ${argv.join(' ')} → ${String(result.code)}: ${result.err}`);
    }
    return JSON.parse(result.out) as T;
  }

  /** The CLI's network: each request goes to the API app through Fastify `inject()`. */
  readonly #fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const reply = await this.#app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: (init?.method ?? 'GET') as 'GET',
        url: `${url.pathname}${url.search}`,
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
      });
    return new Response(reply.statusCode === 204 ? null : reply.body, {
      status: reply.statusCode,
      headers: { 'content-type': String(reply.headers['content-type'] ?? 'application/json') },
    });
  }) as typeof fetch;

  // --- GitHub ------------------------------------------------------------------------------------

  /** A new head commit on the default branch: `text` sets a file, null removes it. */
  commit(changes: Readonly<Record<string, string | null>>): string {
    const files = new Map(this.#commits.get(this.#head) ?? []);
    for (const [file, text] of Object.entries(changes)) {
      if (text === null) files.delete(file);
      else {
        files.set(file, text);
        this.#h.stub.on('GET', `${REPO_PATH}/contents/${file}`, (req) => {
          const content = this.#commits.get(req.query.get('ref') ?? '')?.get(file);
          return content === undefined
            ? { status: 404, body: { message: 'Not Found' } }
            : {
                raw: Buffer.from(content, 'utf8'),
                headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' },
              };
        });
      }
    }
    this.#commitCount += 1;
    this.#head = this.#commitCount.toString(16).padStart(40, '0');
    this.#commits.set(this.#head, files);
    return this.#head;
  }

  /** Commits the intent's plan file (`.sdlc/plans/<INT>.yaml`). */
  commitPlan(intent: Pick<Intent, 'code'>, ...args: [string[]?, string[]?]): string {
    return this.commit({ [planPath(intent.code)]: planYaml(intent.code, ...args) });
  }

  /** A new comment on the intent's issue, by `who` (a bot when `bot` is set). */
  comment(intent: Pick<Intent, 'issue_number'>, body: string, who: Person, bot = false): void {
    this.#commentId += 1;
    // Listed by `updated_at >= since`: one second apart after the clock keeps them in order.
    const at = new Date(this.#now.getTime() + (this.#commentId - 9000) * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    const p = PEOPLE[who];
    this.#comments.push(
      comment(this.#commentId, intent.issue_number!, at, body, {
        author: bot ? user(p.gh + 100, `${p.login}[bot]`, 'Bot') : user(p.gh, p.login),
      }),
    );
  }

  /** One poll of the project: comment commands, replies, notices, status comments. */
  poll(options: { signals?: boolean } = {}): ReturnType<typeof pollProject> {
    return pollProject(
      {
        db: this.#db.app,
        gitHost: this.#h.adapter(),
        registry: this.#registry,
        now: () => this.#h.stub.now,
        ...(options.signals === false ? {} : { intentSignals: this.signals }),
      },
      this.target,
    );
  }

  /** Bodies of the comments the platform posted on the intent's issue. */
  posted(intent: Pick<Intent, 'issue_number'>): string[] {
    return this.#h.stub
      .requestsTo('POST', `${REPO_PATH}/issues/${String(intent.issue_number)}/comments`)
      .map((r) => (r.body as { body: string }).body);
  }

  /** The platform's replies to comment commands on the intent's issue (not status comments). */
  replies(intent: Pick<Intent, 'issue_number'>): string[] {
    return this.posted(intent).filter((body) => body.includes('<!-- sdlc-reply '));
  }

  // --- Reading the state (core, read only) -------------------------------------------------------

  reload(intent: Pick<Intent, 'id'>): Promise<Intent> {
    return this.scope.intents.getById(intent.id) as Promise<Intent>;
  }

  /** Waits until the workflow put the intent at `gate` (status `in_gate`). */
  atGate(intent: Pick<Intent, 'id'>, gate: string): Promise<Intent> {
    return waitFor(
      () => this.reload(intent),
      (i) => i.status === 'in_gate' && i.current_gate === gate,
    );
  }

  /** `[decision, reason_code, decided_by]` of a gate, in order. */
  async decisions(
    intent: Pick<Intent, 'id'>,
    gate: string,
  ): Promise<[string, string | null, string | null][]> {
    return (await this.scope.gateDecisions.listForIntent(intent.id, gate as 'G1')).map((d) => [
      d.decision,
      d.reason_code,
      d.decided_by,
    ]);
  }

  async noticeKinds(intent: Pick<Intent, 'id'>): Promise<string[]> {
    return (await this.scope.intentNotices.listForIntent(intent.id)).map((n) => n.kind);
  }

  escalations(intent: Pick<Intent, 'id'>): Promise<readonly Escalation[]> {
    return this.scope.escalations.listForIntent(intent.id);
  }

  // --- Creating intents through the CLI ----------------------------------------------------------

  /** `sdlc intent create` by Person A, on a new issue. Returns the intent as stored. */
  async createIntent(risk: 'low' | 'medium' | 'high'): Promise<Intent> {
    this.#issue += 1;
    this.#h.stub.on('POST', `${REPO_PATH}/issues/${String(this.#issue)}/comments`, {
      status: 201,
      body: { id: 1 },
    });
    const created = await this.cliJson<{ id: string }>('a', [
      'intent',
      'create',
      '--project',
      PROJECT,
      '--title',
      'Cancel an order',
      '--risk',
      risk,
      '--data-class',
      'internal',
      '--issue',
      String(this.#issue),
    ]);
    return this.reload({ id: created.id });
  }

  /** `sdlc spec link` (Person A) and, after committing the plan file, `sdlc plan submit`. */
  async linkInputs(
    intent: Intent,
    plan: { flags?: string[]; submitter?: Person } = {},
  ): Promise<void> {
    await this.cliJson('a', ['spec', 'link', intent.code, '--path', SPEC_PATH]);
    this.commitPlan(intent, undefined, plan.flags);
    await this.cliJson(plan.submitter ?? 'a', ['plan', 'submit', intent.code]);
  }

  // --- Set-up ------------------------------------------------------------------------------------

  #routeGitHub(): void {
    const stub = this.#h.stub;
    stub.on('GET', REPO_PATH, { body: { id: 1 } });
    stub.on('GET', `${REPO_PATH}/git/ref/heads/main`, () => ({
      body: { ref: 'refs/heads/main', object: { type: 'commit', sha: this.#head } },
    }));
    stub.on('GET', `${REPO_PATH}/issues/comments`, (req) => ({
      body: this.#comments.filter(
        (c) => Date.parse(c.updated_at) >= Date.parse(req.query.get('since')!),
      ),
    }));
    stub.on('GET', `${REPO_PATH}/pulls`, { body: [] });
  }

  /**
   * B13: the operator bootstraps the tenant (`sdlc ops bootstrap`); the tenant admin sets up the
   * project, the people, their GitHub identities, their roles and the configuration through the
   * API (`sdlc admin …`); the operator issues each person's token; Person A saves the AI record.
   */
  async #onboard(options: StackOptions): Promise<void> {
    const boot = await this.cliJson<{ tenant_id: string; token: string }>('operator', [
      'ops',
      'bootstrap',
      '--tenant',
      'acme',
      '--tenant-name',
      'Acme',
      '--email',
      'admin@acme.test',
      '--name',
      'Admin',
    ]);
    this.#tokens.admin = boot.token;
    this.scope = this.#db.app.forTenant(parseTenantId(boot.tenant_id));

    const project = await this.cliJson<{ id: string }>('admin', [
      'admin',
      'project',
      'create',
      '--slug',
      PROJECT,
      '--name',
      'Pilot',
      '--repo',
      `${OWNER}/${REPO}`,
    ]);
    this.target = {
      tenantId: parseTenantId(boot.tenant_id),
      projectId: project.id,
      repoFullName: `${OWNER}/${REPO}`,
    };
    const configFile = path.join(this.#home, 'config.yaml');
    fs.writeFileSync(configFile, PROJECT_CONFIG);
    await this.cliJson('admin', [
      'admin',
      'config',
      'set',
      '--project',
      PROJECT,
      '--file',
      configFile,
      '--expected-version',
      '0',
    ]);

    for (const [person, p] of Object.entries(PEOPLE) as [Person, (typeof PEOPLE)[Person]][]) {
      const email = `${person}@acme.test`;
      const created = await this.cliJson<{ id: string }>('admin', [
        'admin',
        'user',
        'create',
        '--email',
        email,
        '--name',
        person,
      ]);
      this.users[person] = created.id;
      await this.cliJson('admin', [
        'admin',
        'identity',
        'link',
        '--user',
        email,
        '--github-id',
        String(p.gh),
        '--github-login',
        p.login,
      ]);
      await this.cliJson('admin', [
        'admin',
        'role',
        'grant',
        '--project',
        PROJECT,
        '--user',
        email,
        '--role',
        p.role,
      ]);
      const issued = await this.cliJson<{ token: string }>('operator', [
        'ops',
        'token',
        'issue',
        '--tenant',
        'acme',
        '--email',
        email,
        '--name',
        `${person}-laptop`,
      ]);
      this.#tokens[person] = issued.token;
    }

    if (!options.withoutAiRecord) await this.saveAiRecord();
  }

  /** `sdlc ai-record set` by Person A (a write role, rule M19). */
  async saveAiRecord(expectedVersion = 0): Promise<void> {
    await this.cliJson('a', [
      'ai-record',
      'set',
      '--project',
      PROJECT,
      '--expected-version',
      String(expectedVersion),
      '--ai-allowed',
      'yes',
      '--classes',
      'public,internal',
      '--prod-logs',
      'no',
      '--disclosure',
      'standard_note',
    ]);
  }
}
