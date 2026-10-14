// Seeds a tenant for the evaluation plan tests (task L05): a project `shop` with an AI record and
// the default agent `openhands-default` in its configuration, two active agents in the register
// and three people (Person A, a viewer, one without a role).
import { loadProjectConfig } from '@sdlc/config';

import type { PlatformDatabase } from '../../packages/core/src/db/platform-database.js';
import { parseTenantId } from '../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';

export interface PlanWorld {
  readonly scope: TenantScope;
  readonly slug: string;
  readonly projectId: string;
  readonly users: { readonly a: string; readonly viewer: string; readonly outsider: string };
}

export async function seedPlanWorld(
  db: PlatformDatabase,
  slug: string,
  now: Date,
): Promise<PlanWorld> {
  const tenant = await db.system.createTenant({ slug, name: slug, monthlyBudgetUsd: '100' });
  const scope = db.forTenant(parseTenantId(tenant.id));
  const project = await scope.projects.create({
    slug: 'shop',
    name: 'Shop',
    git_provider: 'github',
    repo_full_name: 'org/pilot-order-inventory',
  });
  // The project's default agent, for configurations that name a model only.
  const yaml = 'run:\n  agent_key: openhands-default\n';
  const loaded = loadProjectConfig(yaml);
  if (!loaded.ok) throw new Error('test configuration refused');
  await scope.projectConfigs.save(project.id, {
    configYaml: yaml,
    configHash: loaded.configHash,
    updatedBy: null,
    expectedVersion: 0,
  });
  const user = (name: string) =>
    scope.users.create({ display_name: name, email: `${name}@${slug}.test` });
  const a = await user('pam');
  const viewer = await user('vic');
  const outsider = await user('oz');
  await scope.roleBindings.grant({ user_id: a.id, project_id: project.id, role: 'person_a' });
  await scope.roleBindings.grant({ user_id: viewer.id, project_id: project.id, role: 'viewer' });
  await scope.projectAiRecords.save(project.id, {
    aiAllowed: 'yes',
    allowedDataClasses: ['internal', 'client_restricted'],
    prodLogsAllowed: 'no',
    disclosureFormat: 'standard_note',
    confirmedAt: null,
    recordRef: null,
    updatedBy: a.id,
    expectedVersion: 0,
    actorType: 'human',
    today: '2026-10-14',
  });
  for (const [key, model] of [
    ['openhands-default', 'gpt-oss-20b'],
    ['openhands-qwen', 'qwen3-8b'],
  ] as const) {
    const agent = await scope.agents.create({
      agentKey: key,
      version: '1.0.0',
      ownerId: a.id,
      modelRef: model,
      instructionsRef: 'AGENTS.md@v1',
      instructionsSha256: 'd'.repeat(64),
      allowedTools: ['file_editor', 'task_tracker', 'terminal'],
      maxAutonomy: 'L2',
      approvedEnvironments: ['sandbox'],
    });
    await scope.agents.update(agent.id, { status: 'active', lastRecertifiedAt: '2026-10-14' }, now);
  }
  return {
    scope,
    slug,
    projectId: project.id,
    users: { a: a.id, viewer: viewer.id, outsider: outsider.id },
  };
}
