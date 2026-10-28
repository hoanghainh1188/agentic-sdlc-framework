// What the platform holds today for a project file (task V17 AC3, AC4): read only, through the
// same API endpoints as `sdlc admin … list|show`. Nothing here writes.
import type { ProjectFile } from '@sdlc/api-schemas';

import { ApiCallError, type ApiClient } from '../../api/client.js';
import {
  adminConfigSchema,
  adminIdentityListSchema,
  adminProjectSchema,
  adminRoleListSchema,
  adminUserListSchema,
  agentSchema,
  aiRecordSchema,
  meSchema,
  type AdminConfigView,
  type AdminIdentityView,
  type AdminProjectView,
  type AdminRoleView,
  type AdminUserView,
  type AgentView,
} from '../../api/schemas.js';
import { segment } from '../../api/session.js';

export interface CurrentState {
  /** The user ID of the person who runs the command (nobody grants a role to themselves). */
  readonly me: string;
  readonly project: AdminProjectView | null;
  /** The tenant's users, by lower-case e-mail address. */
  readonly users: ReadonlyMap<string, AdminUserView>;
  /** The linked GitHub accounts of each user of the file who exists, by user ID. */
  readonly identities: ReadonlyMap<string, readonly AdminIdentityView[]>;
  /** The project's active role bindings. */
  readonly roles: readonly AdminRoleView[];
  readonly config: AdminConfigView | null;
  readonly agent: AgentView | null;
  /** Whether the project AI record exists; `unknown` when the caller may not read it. */
  readonly aiRecord: 'present' | 'missing' | 'unknown';
}

/** A 404 is "missing"; any other error stops the command. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiCallError && error.kind === 'http' && error.status === 404) return null;
    throw error;
  }
}

export async function readState(client: ApiClient, file: ProjectFile): Promise<CurrentState> {
  const projectPath = `/v1/admin/projects/${segment(file.project.slug)}`;
  const me = await client.get('/v1/me', meSchema);
  const project = await orNull(() => client.get(projectPath, adminProjectSchema));
  const list = await client.get('/v1/admin/users', adminUserListSchema);
  const users = new Map(list.items.map((user) => [user.email.toLowerCase(), user]));
  const identities = new Map<string, readonly AdminIdentityView[]>();
  for (const person of file.team) {
    const user = users.get(person.email.toLowerCase());
    if (!user) continue;
    const linked = await client.get(
      `/v1/admin/users/${segment(user.id)}/identities`,
      adminIdentityListSchema,
    );
    identities.set(
      user.id,
      linked.items.filter((item) => item.provider === 'github' && item.unlinked_at === null),
    );
  }
  const roles = project
    ? (await client.get(`${projectPath}/roles`, adminRoleListSchema)).items.filter(
        (role) => role.revoked_at === null,
      )
    : [];
  const config = project ? await client.get(`${projectPath}/config`, adminConfigSchema) : null;
  const agentKey = file.agent?.key;
  const agent =
    agentKey === undefined
      ? null
      : await orNull(() => client.get(`/v1/admin/agents/${segment(agentKey)}`, agentSchema));
  return {
    me: me.user.id,
    project,
    users,
    identities,
    roles,
    config,
    agent,
    aiRecord: project ? await aiRecordState(client, file.project.slug) : 'missing',
  };
}

async function aiRecordState(client: ApiClient, slug: string): Promise<CurrentState['aiRecord']> {
  try {
    await client.get(`/v1/projects/${segment(slug)}/ai-record`, aiRecordSchema);
    return 'present';
  } catch (error) {
    if (error instanceof ApiCallError && error.kind === 'http') {
      return error.status === 404 ? 'missing' : 'unknown';
    }
    throw error;
  }
}
