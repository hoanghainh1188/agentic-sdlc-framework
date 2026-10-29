// Runs the writes of `adlc admin project apply` (task V17 AC4), one API call per change, with the
// same endpoints and bodies as the manual commands (`project create|update`, `user create|update`,
// `identity link`, `role grant`, `agent register`, `config set`), so the audit log is the same.
// It never calls an approval, the AI record or a token endpoint (AC5).
import type { ApiClient } from '../../api/client.js';
import {
  adminConfigSchema,
  adminIdentitySchema,
  adminProjectSchema,
  adminRoleSchema,
  adminUserSchema,
  agentSchema,
} from '../../api/schemas.js';
import { segment } from '../../api/session.js';
import type { CheckedFile } from './file.js';
import type { Write } from './plan.js';
import type { CurrentState } from './state.js';

export class ApplyStopped extends Error {
  constructor(
    readonly done: number,
    readonly failure: unknown,
  ) {
    super('apply_stopped');
  }
}

/** Runs `writes` in order; stops at the first failure (`ApplyStopped` holds how many were done). */
export async function applyWrites(
  client: ApiClient,
  checked: CheckedFile,
  state: CurrentState,
  writes: readonly Write[],
): Promise<void> {
  const projectPath = `/v1/admin/projects/${segment(checked.file.project.slug)}`;
  const userIds = new Map([...state.users].map(([email, user]) => [email, user.id]));
  const userId = (email: string): string => {
    const found = userIds.get(email.toLowerCase());
    if (found === undefined) throw new Error('user_missing_after_create');
    return found;
  };
  let done = 0;
  for (const write of writes) {
    try {
      switch (write.kind) {
        case 'project_create':
          await client.post('/v1/admin/projects', adminProjectSchema, write.body);
          break;
        case 'project_update':
          await client.patch(projectPath, adminProjectSchema, write.body);
          break;
        case 'user_create': {
          const created = await client.post('/v1/admin/users', adminUserSchema, {
            email: write.email,
            display_name: write.name,
          });
          userIds.set(write.email.toLowerCase(), created.id);
          break;
        }
        case 'user_update':
          await client.patch(`/v1/admin/users/${segment(userId(write.email))}`, adminUserSchema, {
            display_name: write.name,
          });
          break;
        case 'identity_link':
          await client.post(
            `/v1/admin/users/${segment(userId(write.email))}/identities`,
            adminIdentitySchema,
            { provider: 'github', external_id: write.githubId, external_login: write.login },
          );
          break;
        case 'role_grant':
          await client.post(`${projectPath}/roles`, adminRoleSchema, {
            user_id: userId(write.email),
            role: write.role,
          });
          break;
        case 'agent_register':
          await client.post(
            '/v1/admin/agents',
            agentSchema,
            agentBody(checked, userId(write.owner)),
          );
          break;
        case 'config_set':
          await client.put(`${projectPath}/config`, adminConfigSchema, {
            expected_version: write.expectedVersion,
            config_yaml: write.yaml,
          });
          break;
      }
    } catch (error) {
      throw new ApplyStopped(done, error);
    }
    done += 1;
  }
}

/** The body of `adlc admin agent register`. */
function agentBody(checked: CheckedFile, ownerId: string): Record<string, unknown> {
  const agent = checked.file.agent;
  if (!agent || checked.instructionsSha256 === undefined) throw new Error('agent_missing');
  const fields: Record<string, unknown> = {
    key: agent.key,
    version: agent.version,
    owner_id: ownerId,
    instructions_sha256: checked.instructionsSha256,
    instructions_ref: agent.instructions,
    model_ref: agent.model,
    allowed_tools: agent.tools,
    max_autonomy: agent.max_autonomy,
    approved_environments: agent.environments,
    adapter: agent.adapter,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
