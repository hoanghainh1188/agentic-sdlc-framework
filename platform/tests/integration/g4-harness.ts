// Shared set-up of the G4 and run tests (task C06): the workflow fixture (B07), an active agent
// with its instructions file, the G4 facts the tests change (base commit, instructions, models,
// the Git host up or down), and fakes for what `prepareRun` needs (signer, Cost Controller, GitHub
// token, wrapping). Used by integration/db (gate-g4, run-lifecycle) and integration/workflow.
import crypto from 'node:crypto';

import { loadProjectConfig } from '@sdlc/config';

import { GitHostError, type RedactedSecret } from '../../packages/contracts/src/index.js';
import { decideGate } from '../../packages/core/src/commands/gate-command.js';
import type { CostError } from '../../packages/core/src/cost/errors.js';
import type { Intent } from '../../packages/core/src/db/schema.js';
import type { G4Deps } from '../../packages/core/src/workflow/g4-proposal.js';
import type { RunDeps } from '../../packages/core/src/workflow/run-lifecycle.js';
import { stepIntent } from '../../packages/core/src/workflow/step.js';
import { FakeTransit } from '../run-contract/helpers.js';
import { seedAgent, type SeededAgent } from './agent-seed.js';
import type { TestDatabase } from './db/helpers.js';
import { createWorkflowFixture, type Person, type WorkflowFixture } from './workflow/fixture.js';

// Monday 08:00 in Ho Chi Minh City (the default calendar), one hour before the working day.
export const T0 = new Date('2026-09-28T01:00:00.000Z');
export const HOUR = 3_600_000;
export const BASE_1 = '1'.repeat(40);
export const BASE_2 = '2'.repeat(40);
export const AGENTS_MD = '# AGENTS.md\nRun `pnpm test` before you finish.\n';
export const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
export const MODEL = 'gpt-oss-20b';

export class Secret implements RedactedSecret {
  constructor(readonly value: string) {}
  reveal(): string {
    return this.value;
  }
}

/** The facts G4 reads outside the database, changed by the tests. */
export interface World {
  base: string;
  instructions: string | null;
  models: string[];
  gitDown: boolean;
  /** The tenant's monthly budget; null: none. */
  tenantBudget: string | null;
  /** The paths at the base commit (C07, `listPaths`); `truncated`: the host lists them in part. */
  paths: string[] | 'truncated';
}

export interface Harness {
  readonly f: WorkflowFixture;
  readonly world: World;
  readonly g4: G4Deps;
  agent: SeededAgent;
  setClock(at: Date): void;
  settle(intent: Intent): ReturnType<typeof stepIntent>;
  /** The step as the session 2 worker runs it (`startRuns`); stops at a run outcome too. */
  settleRuns(intent: Intent): ReturnType<typeof stepIntent>;
  /** Fakes of what `prepareRun` and the run lifecycle need; calls are recorded. */
  readonly runDeps: RunDeps;
  readonly calls: RunCalls;
  reload(intent: Intent): Promise<Intent>;
  decide(
    intent: Intent,
    decision: 'approve' | 'reject',
    who: Person,
  ): ReturnType<typeof decideGate>;
  setConfig(yaml: string): Promise<void>;
  g4Decisions(intent: Intent): Promise<[string, string | null, string][]>;
}

export async function harness(db: TestDatabase): Promise<Harness> {
  let clock = T0;
  const f = await createWorkflowFixture(db, () => clock);
  f.h.stub.now = T0;
  const world: World = {
    base: BASE_1,
    instructions: AGENTS_MD,
    models: [MODEL],
    gitDown: false,
    tenantBudget: null,
    paths: ['AGENTS.md', 'src/main.ts'],
  };
  const g4: G4Deps = {
    gitHost: {
      getBranchHead: () =>
        world.gitDown
          ? Promise.reject(new GitHostError('server_error'))
          : Promise.resolve(world.base),
      getFileAtCommit: () =>
        world.instructions === null
          ? Promise.reject(new GitHostError('not_found'))
          : Promise.resolve(world.instructions),
      listPaths: () =>
        world.paths === 'truncated'
          ? Promise.reject(new GitHostError('tree_truncated'))
          : Promise.resolve([...world.paths]),
    },
    allowedModels: () => Promise.resolve([...world.models]),
    tenantMonthlyBudget: () => Promise.resolve(world.tenantBudget),
  };
  let configVersion = 0;
  const calls: RunCalls = { keys: [], revoked: [], wrapped: [], refuseKey: undefined };
  const t: Harness = {
    f,
    world,
    g4,
    agent: await seedAgent(f.scope, f.users.a, {
      model: MODEL,
      instructionsSha256: sha256(AGENTS_MD),
      tools: ['file_editor', 'terminal'],
    }),
    setClock(at) {
      clock = at;
      f.h.stub.now = at;
    },
    async settle(intent) {
      for (let i = 0; i < 12; i += 1) {
        const result = await stepIntent(f.scope, { registry: f.registry, g4 }, intent.id);
        if (result.outcome !== 'moved') return result;
      }
      throw new Error('the step never settled');
    },
    async settleRuns(intent) {
      for (let i = 0; i < 12; i += 1) {
        const result = await stepIntent(
          f.scope,
          { registry: f.registry, g4, startRuns: true },
          intent.id,
        );
        if (result.outcome !== 'moved') return result;
      }
      throw new Error('the step never settled');
    },
    runDeps: fakeRunDeps(f, g4, calls),
    calls,
    reload: async (intent) => (await f.scope.intents.getById(intent.id))!,
    decide: (intent, decision, who) =>
      decideGate(f.registry, f.scope, {
        intent,
        gate: 'G4',
        decision,
        actorId: f.users[who],
        reasonCode: decision === 'approve' ? null : 'policy_denied',
        source: 'cli',
      }),
    async setConfig(yaml) {
      const loaded = loadProjectConfig(yaml);
      if (!loaded.ok) throw new Error('test configuration refused');
      await f.scope.projectConfigs.save(f.target.projectId, {
        configYaml: yaml,
        configHash: loaded.configHash,
        updatedBy: null,
        expectedVersion: configVersion,
      });
      configVersion += 1;
    },
    async g4Decisions(intent) {
      return (await f.scope.gateDecisions.listForIntent(intent.id, 'G4')).map((d) => [
        d.decision,
        d.reason_code,
        d.oversight_mode,
      ]);
    },
  };
  await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
  return t;
}

/**
 * Brings a new intent to an approved G3 through people's approvals (Medium and High: G1–G3 are
 * HITL). The next step moves it to G4 and evaluates G4 with the world as the test set it.
 */
export async function atG4(t: Harness, riskTier: 'medium' | 'high' | 'critical'): Promise<Intent> {
  const intent = await t.f.newIntent({ riskTier });
  const approver = riskTier === 'medium' ? 'a' : 'b';
  await t.settle(intent);
  await decideAt(t, intent, 'G1', 'a');
  await t.f.addInputs(intent);
  await t.settle(intent);
  await decideAt(t, intent, 'G2', approver);
  await approve(t, intent, 'G3', 'b');
  return intent;
}

export async function approve(t: Harness, intent: Intent, gate: 'G1' | 'G2' | 'G3', who: Person) {
  await decideGate(t.f.registry, t.f.scope, {
    intent: await t.reload(intent),
    gate,
    decision: 'approve',
    actorId: t.f.users[who],
    source: 'cli',
  });
}

export async function decideAt(t: Harness, intent: Intent, gate: 'G1' | 'G2' | 'G3', who: Person) {
  await approve(t, intent, gate, who);
  await t.settle(intent);
}

/** Polls until the platform has posted every pending comment (a poll posts a batch). */
export async function flush(t: Harness): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const before = t.f.h.stub.requests.length;
    await t.f.poll();
    // A poll with nothing to post only reads GitHub (comments, pulls): no POST.
    const posts = t.f.h.stub.requests.slice(before).filter((r) => r.method === 'POST');
    if (posts.length === 0) return;
  }
}

export async function notices(t: Harness, intent: Intent) {
  return (await t.f.scope.intentNotices.listForIntent(intent.id)).map((n) => n.kind);
}

export async function checksFailed(t: Harness, intent: Intent): Promise<string[]> {
  return (await t.f.scope.audit.listForEntity(intent.id, ['gate.g4_check_failed'])).map(
    (e) => (e.payload as { check: string }).check,
  );
}

/** What the fakes of `fakeRunDeps` saw. `refuseKey` makes the next key requests fail. */
export interface RunCalls {
  readonly keys: string[];
  /** Run IDs whose key was revoked (by run), or key IDs (by key). */
  readonly revoked: string[];
  readonly wrapped: string[][];
  refuseKey: CostError | undefined;
}

export function fakeRunDeps(f: WorkflowFixture, g4: G4Deps, calls: RunCalls): RunDeps {
  return {
    registry: f.registry,
    g4,
    signer: new FakeTransit(),
    costController: {
      issueRunKey: (input) => {
        if (calls.refuseKey) return Promise.reject(calls.refuseKey);
        calls.keys.push(input.runId);
        return Promise.resolve({
          key: { keyId: `key-${input.runId}`, key: new Secret('sk-virtual'), expiresAt: T0 },
          labels: {} as never,
          maxBudgetUsd: '2',
          limitedBy: 'run' as const,
        });
      },
      endRun: (input) => {
        calls.revoked.push(input.keyId);
        return Promise.resolve({} as never);
      },
      endRunKey: (input) => {
        calls.revoked.push(input.runId);
        return Promise.resolve({} as never);
      },
    },
    gitHost: {
      issueShortLivedToken: (repo, scope) =>
        Promise.resolve({
          token: new Secret('ghs_token'),
          expiresAt: T0.toISOString(),
          repo,
          permissions: scope.permissions,
        }),
    },
    wrapper: {
      wrap: (fields, options) => {
        calls.wrapped.push([...Object.keys(fields), String(options.ttlSeconds)]);
        return Promise.resolve(new Secret(`wrap-${Object.keys(fields).join()}`));
      },
    },
    egressAllowlist: ['npm-proxy:4873', 'litellm:4000'],
  };
}
