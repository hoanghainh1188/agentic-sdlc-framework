// Shared set-up of the C05 live tests (ADR-M29): a fixture repository, a Run Contract bound to it,
// a relay that stands in for the runner's own container, and a running sandbox with the clone.
// C07: the fixture repository is laid out like the runner's own clone (`<clone>/repo`, `home`),
// so the runs' changes are computed from the real sandbox (`changesStep`, ADR-M34 §2.2).
// Test infrastructure goes through the docker CLI; the sandbox, the network attachment and the
// clean-up are the runner code under test.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { loadProjectConfig } from '@sdlc/config';
import type {
  EvidenceStore,
  RedactedSecret,
  RunContractEnvelope,
  StoredEvidence,
} from '@sdlc/contracts';

import {
  createSandbox,
  packDirectory,
  runnerSettingsFromEnv,
  storeChanges,
  type AgentDriveDeps,
  type DockerClient,
  type RunnerSettings,
  type Sandbox,
} from '../../../apps/runner/src/index.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { issueRunContract } from '../../../packages/core/src/run-contract/index.js';
import { seedAgent } from '../agent-seed.js';
import type { TestDatabase } from '../db/helpers.js';
import { docker, dockerSocket } from '../runner/live-helpers';
import { repoRoot } from '../../workspace/helpers';

export const NODE_IMAGE =
  'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
export const SPEC_PATH = 'docs/specs/T01-labels.md';
export const here = path.join(repoRoot(), 'platform/tests/integration/agent');

const registry = new Registry({ policyFactory: (config) => createSimplePolicyEngine({ config }) });
const signer = {
  sign: () => Promise.resolve({ signature: 'vault:v1:c2lnbmF0dXJl', keyVersion: 1 }),
};

export const secret = (value: string) =>
  ({ reveal: () => value, toString: () => '[redacted]' }) as RedactedSecret;

export interface AgentRunFixture {
  readonly scope: TenantScope;
  readonly envelope: RunContractEnvelope;
  readonly sandbox: Sandbox;
  readonly settings: RunnerSettings;
  readonly relay: string;
  readonly relayUrl: string;
  readonly repoBase: string;
  /** The fixture repository laid out like the runner's own clone (C07). */
  readonly cloneDir: string;
}

export interface StartAgentRun {
  readonly t: TestDatabase;
  readonly client: DockerClient;
  /** node24 by digest. */
  readonly image: string;
  readonly tmp: string;
  /** Unique per test file (runner instance label). */
  readonly suffix: string;
  /** Tenant slug; unique per database. */
  readonly slug: string;
  /** Container that serves as LiteLLM on the run's network (egress alias `litellm`, port 4000). */
  readonly litellmContainer: string;
  readonly model: string;
  readonly planSummary: string;
  readonly specText: string;
  readonly agentsMd: string;
  readonly caps: { readonly maxIterations: number; readonly maxDurationMin: number };
  /**
   * The project's configuration YAML, stored before the contract is issued (C11 PR 2: the loop
   * threshold goes into the contract; the runner reads the no-progress window at run start).
   */
  readonly configYaml?: string;
  /** Runs after the claim, while the run is `provisioning` (the Cost Controller issues its key). */
  readonly afterClaim?: (scope: TenantScope, envelope: RunContractEnvelope) => Promise<void>;
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=f@f.invalid', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();

/** A fixture repository, a contract bound to it, and a running sandbox with the clone. */
export async function startAgentRun(input: StartAgentRun): Promise<AgentRunFixture> {
  const cloneDir = fs.mkdtempSync(path.join(input.tmp, 'run-'));
  const repo = path.join(cloneDir, 'repo');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(cloneDir, 'home'));
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'docs/specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture\n');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), input.agentsMd);
  fs.writeFileSync(path.join(repo, SPEC_PATH), input.specText);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  const baseSha = git(repo, 'rev-parse', 'HEAD');

  const tenant = await input.t.app.system.createTenant({ slug: input.slug, name: input.slug });
  const scope = input.t.app.forTenant(parseTenantId(tenant.id));
  const project = await scope.projects.create({
    slug: 'fixture',
    name: 'Fixture',
    git_provider: 'github',
    repo_full_name: 'org/fixture',
  });
  if (input.configYaml !== undefined) {
    const loaded = loadProjectConfig(input.configYaml);
    if (!loaded.ok) throw new Error('test configuration refused');
    await scope.projectConfigs.save(project.id, {
      configYaml: input.configYaml,
      configHash: loaded.configHash,
      updatedBy: null,
      expectedVersion: 0,
    });
  }
  const person = (await scope.users.create({ display_name: 'a', email: 'a@example.com' })).id;
  const intent = await registry.createIntent(scope, {
    projectId: project.id,
    title: 'Hello',
    createdBy: person,
    riskTier: 'low',
    dataClass: 'internal',
  });
  const blob = fs.readFileSync(path.join(repo, SPEC_PATH));
  await registry.linkSpec(scope, intent.id, {
    path: SPEC_PATH,
    commitSha: baseSha,
    contentSha256: crypto.createHash('sha256').update(blob).digest('hex'),
    actorType: 'human',
    actorId: person,
  });
  const plan = await registry.submitPlan(scope, intent.id, {
    plannedFiles: ['hello.txt'],
    summary: input.planSummary,
    planSha256: 'b'.repeat(64),
    actorType: 'human',
    actorId: person,
  });
  const agent = await seedAgent(scope, person, { tools: ['file_editor', 'terminal'] });
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
        tools: ['file_editor', 'terminal'],
      },
      planTools: ['file_editor', 'terminal'],
      autonomyLevel: 'L2',
      maxBudgetUsd: '1',
      ...input.caps,
      allowedModels: [input.model],
      egressAllowlist: ['litellm:4000'],
      triggeredBy: null,
    },
    { signer },
  );
  const { contract } = envelope;
  git(repo, 'checkout', '-q', '-b', contract.branch);

  // The relay stands in for the runner's container (SDLC_RUNNER_SELF_CONTAINER).
  const relay = `sdlc-c05-relay-${contract.run_id.slice(0, 8)}`;
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
    `TARGET_HOST=sdlc-sandbox-${contract.run_id}`,
    '-v',
    `${path.join(here, 'relay.mjs')}:/relay/relay.mjs:ro`,
    NODE_IMAGE,
    'node',
    '/relay/relay.mjs',
  );
  const port = docker('port', relay, '8000/tcp').split('\n')[0]!.split(':').pop()!;

  const settings = runnerSettingsFromEnv({
    SDLC_RUNNER_DOCKER_SOCKET: dockerSocket(),
    SDLC_RUNNER_INSTANCE: `c05-${input.suffix}`,
    SDLC_RUNNER_EGRESS_SERVICES: `litellm=${input.litellmContainer}:4000`,
    SDLC_RUNNER_SELF_CONTAINER: relay,
    SDLC_RUNNER_AGENT_POLL_MS: '250',
    SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS: '300',
  });
  await scope.runs.claimForProvisioning(contract.run_id, new Date());
  await input.afterClaim?.(scope, envelope);
  const sandbox = await createSandbox(input.client, settings, {
    runId: contract.run_id,
    tenantId: tenant.id,
    image: input.image,
    egressAllowlist: contract.egress_allowlist,
    workspaceTar: packDirectory(repo, 256 * 1024 * 1024),
  });
  for (let i = 0; ; i++) {
    const health = (await input.client.containerInspect(sandbox.containerId))?.State.Health?.Status;
    if (health === 'healthy') break;
    if (i > 240) throw new Error(`sandbox not healthy: ${String(health)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  await scope.runs.transition(contract.run_id, {
    from: ['provisioning'],
    to: 'running',
    now: new Date(),
  });
  return {
    scope,
    envelope,
    sandbox,
    settings,
    relay,
    relayUrl: `http://127.0.0.1:${port}`,
    repoBase: baseSha,
    cloneDir,
  };
}

/**
 * The runner's changes step for a fixture run (C07, ADR-M34 §2.2): the real export from the
 * sandbox, the hardened diff in the fixture clone, the default policy; diffs go to `puts`.
 */
export function changesStep(
  t: TestDatabase,
  client: DockerClient,
  run: AgentRunFixture,
  puts: { path: string; content: Buffer }[],
): Pick<AgentDriveDeps, 'changes'> {
  const evidence: EvidenceStore = {
    put: (tenantId, p, content): Promise<StoredEvidence> => {
      puts.push({ path: p, content });
      return Promise.resolve({
        uri: `s3://evidence/diffs/${tenantId}/${p}`,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        sizeBytes: content.length,
      });
    },
    get: () => Promise.reject(new Error('not used')),
  };
  const loaded = loadProjectConfig('');
  if (!loaded.ok) throw new Error('default configuration refused');
  const policy = createSimplePolicyEngine({ config: loaded.config });
  return {
    changes: async (contract) => {
      const checked = await storeChanges(
        {
          db: t.app as unknown as AgentDriveDeps['db'],
          docker: client,
          settings: run.settings,
          evidence,
          policy,
        },
        contract,
        run.cloneDir,
      );
      return { changedFiles: checked.changedFiles };
    },
  };
}
