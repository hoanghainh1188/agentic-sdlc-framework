// B09 PR 2 on PostgreSQL (design/ADR-M40 §2.7, QUESTIONS #169, #210): the runner reads a plan
// read from a file at the plan's commit from its own clone (a real local Git repository here),
// checks the SHA-256 of its bytes against the contract's `plan_sha256`, and gives the agent the
// tasks' text. A mismatch, a missing file or commit, no clone, or other path patterns fail closed
// (`task_unavailable`) with `plan_unavailable` and its cause. A plan stored without a file keeps
// its summary. Run events hold counts and codes only: never the plan text.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { RunContract } from '@sdlc/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { loadAgentTask, planFileReader } from '../../../apps/runner/src/index.js';
import { AgentRunError } from '../../../apps/runner/src/agent/errors.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { planPath } from '../../../packages/core/src/plans/index.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { issueRunContract } from '../../../packages/core/src/run-contract/index.js';
import { seedAgent } from '../agent-seed.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const MARKER = 'PLAN-MARKER-db-5c2e';
const BASE = 'a'.repeat(40);
const registry = new Registry({ policyFactory: (config) => createSimplePolicyEngine({ config }) });
const signer = {
  sign: () => Promise.resolve({ signature: 'vault:v1:c2lnbmF0dXJl', keyVersion: 1 }),
};

function planYaml(code: string, paths = ['apps/web/src/products/**']): string {
  return [
    'plan:',
    `  intent_id: ${code}`,
    'tasks:',
    '  - id: T1',
    `    summary: ${MARKER} add Japanese labels`,
    '    owner_agent: coder',
    '    allowed_paths: [' + paths.join(', ') + ']',
    '    tools: [file_editor, terminal]',
    '    definition_of_done: [labels shown, tests pass]',
    '    required_evidence: [unit_tests]',
    '    input:',
    '      nested: not text',
    '',
  ].join('\n');
}

/** The runner is built against core's compiled types; the tests use core's sources. */
const asScope = (scope: TenantScope) => scope as unknown as Parameters<typeof loadAgentTask>[0];

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describeDb('B09 PR 2: the runner reads the plan file for the prompt, on PostgreSQL', () => {
  let t: TestDatabase;
  let root: string;
  let tenants = 0;

  /** The runner's clone (`<clone>/repo`, `<clone>/home`): one commit per call. */
  function cloneWith(files: Record<string, string>): { cloneDir: string; commit: string } {
    const cloneDir = fs.mkdtempSync(path.join(root, 'clone-'));
    const repo = path.join(cloneDir, 'repo');
    fs.mkdirSync(path.join(cloneDir, 'home'));
    fs.mkdirSync(repo);
    const git = (args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        env: {
          PATH: process.env.PATH,
          HOME: path.join(cloneDir, 'home'),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.invalid',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.invalid',
        },
      })
        .toString()
        .trim();
    git(['init', '-q']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# shop\n');
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'c']);
    return { cloneDir, commit: git(['rev-parse', 'HEAD']) };
  }

  interface Seeded {
    readonly scope: TenantScope;
    readonly contract: RunContract;
    readonly code: string;
  }

  /** An intent with a spec and a plan (from a file at `commit`, or without one), and a contract. */
  async function seed(plan: { file: string; commit: string } | 'old'): Promise<Seeded> {
    const slug = `plan-prompt-${String(++tenants)}`;
    const tenant = await t.app.system.createTenant({ slug, name: slug });
    const scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'org/pilot-order-inventory',
    });
    const personA = (await scope.users.create({ display_name: 'a', email: 'a@example.com' })).id;
    const intent = await registry.createIntent(scope, {
      projectId: project.id,
      title: 'Add Japanese labels',
      createdBy: personA,
      riskTier: 'low',
      dataClass: 'internal',
    });
    await registry.linkSpec(scope, intent.id, {
      path: 'docs/specs/T01-japanese-labels.md',
      commitSha: BASE,
      contentSha256: 'd'.repeat(64),
      actorType: 'human',
      actorId: personA,
    });
    const stored = await registry.submitPlan(
      scope,
      intent.id,
      plan === 'old'
        ? {
            plannedFiles: ['apps/web/src/products/**'],
            summary: 'Add Japanese labels to the product list.',
            planSha256: 'b'.repeat(64),
            actorType: 'human',
            actorId: personA,
          }
        : {
            plannedFiles: ['apps/web/src/products/**'],
            planSha256: sha256(plan.file),
            actorType: 'human',
            actorId: personA,
            file: { commitSha: plan.commit, allowedTools: ['file_editor', 'terminal'] },
          },
    );
    const agent = await seedAgent(scope, personA, { tools: ['file_editor', 'terminal'] });
    const { envelope } = await issueRunContract(
      scope,
      {
        intentId: intent.id,
        planId: stored.id,
        baseSha: BASE,
        agent: {
          id: agent.id,
          version: '1.0.0',
          instructionsSha256: 'c'.repeat(64),
          tools: ['file_editor', 'terminal'],
        },
        planTools: ['file_editor', 'terminal'],
        autonomyLevel: 'L2',
        maxBudgetUsd: '1',
        maxIterations: 30,
        maxDurationMin: 60,
        allowedModels: ['stub-model'],
        egressAllowlist: ['litellm:4000'],
        triggeredBy: null,
      },
      { signer },
    );
    return { scope, contract: envelope.contract, code: intent.code };
  }

  const events = async (s: Seeded) =>
    (await s.scope.runEvents.list(s.contract.run_id))
      .filter((e) => e.event_type.startsWith('plan_'))
      .map((e) => [e.event_type, e.payload] as const);

  const failure = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      return error instanceof AgentRunError ? error.reason : 'other';
    }
    return 'none';
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-prompt-'));
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * The plan path holds the intent code, which the database assigns. Codes are sequential per
   * tenant, so every tenant's first intent has the same code: seed once to learn it.
   */
  async function firstCode(): Promise<string> {
    const probe = cloneWith({});
    return (await seed({ file: '', commit: probe.commit })).code;
  }

  it('the hash matches: the tasks text reaches the task; plan_read holds counts only', async () => {
    const code = await firstCode();
    const text = planYaml(code);
    const clone = cloneWith({ [planPath(code)]: text });
    const s = await seed({ file: text, commit: clone.commit });
    expect(s.code).toBe(code);

    const task = await loadAgentTask(
      asScope(s.scope),
      s.contract,
      {},
      planFileReader(clone.cloneDir, 10_000),
    );
    expect(task.plan.summary).toBe('');
    expect(task.plan.taskText).toMatchObject({ tasks: 1, truncated: false });
    const shown = task.plan.taskText!.text;
    expect(shown).toContain(`summary: ${MARKER} add Japanese labels`);
    expect(shown).toContain('definition of done:\n- labels shown\n- tests pass');
    expect(shown).not.toContain('owner agent');
    expect(shown).not.toContain('required evidence');
    expect(await events(s)).toEqual([
      ['plan_read', { tasks: 1, chars: shown.length, truncated: 'no', skipped_fields: 1 }],
    ]);
    const stored = JSON.stringify(await s.scope.runEvents.list(s.contract.run_id));
    expect(stored).not.toContain(MARKER);
  });

  it('the file at the commit is not the submitted plan: hash_mismatch', async () => {
    const code = await firstCode();
    const clone = cloneWith({ [planPath(code)]: `${planYaml(code)}# edited\n` });
    const s = await seed({ file: planYaml(code), commit: clone.commit });
    const reader = planFileReader(clone.cloneDir, 10_000);
    expect(await failure(loadAgentTask(asScope(s.scope), s.contract, {}, reader))).toBe(
      'task_unavailable',
    );
    expect(await events(s)).toEqual([['plan_unavailable', { reason: 'hash_mismatch' }]]);
  });

  it('no file at the commit: missing; a commit not in the clone: commit_missing', async () => {
    const code = await firstCode();
    const empty = cloneWith({});
    const s = await seed({ file: planYaml(code), commit: empty.commit });
    const reader = planFileReader(empty.cloneDir, 10_000);
    expect(await failure(loadAgentTask(asScope(s.scope), s.contract, {}, reader))).toBe(
      'task_unavailable',
    );
    expect(await events(s)).toEqual([['plan_unavailable', { reason: 'missing' }]]);

    const elsewhere = await seed({ file: planYaml(code), commit: 'e'.repeat(40) });
    expect(
      await failure(loadAgentTask(asScope(elsewhere.scope), elsewhere.contract, {}, reader)),
    ).toBe('task_unavailable');
    expect(await events(elsewhere)).toEqual([['plan_unavailable', { reason: 'commit_missing' }]]);
  });

  it('no clone reader: no_clone; other path patterns in the file: files_mismatch', async () => {
    const code = await firstCode();
    const text = planYaml(code);
    const clone = cloneWith({ [planPath(code)]: text });
    const s = await seed({ file: text, commit: clone.commit });
    expect(await failure(loadAgentTask(asScope(s.scope), s.contract, {}))).toBe('task_unavailable');
    expect(await events(s)).toEqual([['plan_unavailable', { reason: 'no_clone' }]]);

    const other = planYaml(code, ['apps/api/src/**']);
    const otherClone = cloneWith({ [planPath(code)]: other });
    const o = await seed({ file: other, commit: otherClone.commit });
    const reader = planFileReader(otherClone.cloneDir, 10_000);
    expect(await failure(loadAgentTask(asScope(o.scope), o.contract, {}, reader))).toBe(
      'task_unavailable',
    );
    expect(await events(o)).toEqual([['plan_unavailable', { reason: 'files_mismatch' }]]);
  });

  it('the same path patterns in another order and repeated: a set, accepted', async () => {
    const code = await firstCode();
    const text = planYaml(code, ['apps/web/src/products/**', 'apps/web/src/products/**']);
    const clone = cloneWith({ [planPath(code)]: text });
    const s = await seed({ file: text, commit: clone.commit });
    const task = await loadAgentTask(
      asScope(s.scope),
      s.contract,
      {},
      planFileReader(clone.cloneDir, 10_000),
    );
    expect(task.plan.taskText?.tasks).toBe(1);
  });

  it('a plan stored without a file keeps its summary; no plan event', async () => {
    const s = await seed('old');
    const task = await loadAgentTask(asScope(s.scope), s.contract, {});
    expect(task.plan).toEqual({
      summary: 'Add Japanese labels to the product list.',
      plannedFiles: ['apps/web/src/products/**'],
    });
    expect(await events(s)).toEqual([]);
  });
});
