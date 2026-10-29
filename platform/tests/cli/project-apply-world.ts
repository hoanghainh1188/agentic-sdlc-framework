// A small in-memory platform and GitHub for `adlc admin project apply` (task V17): the admin
// endpoints answer from a world that the writes change, so a second run sees the first one's
// work. Bodies come from the API's own presenters (fixtures.ts).
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  agentBody,
  meBody,
  PROJECT,
  projectBody,
  identityBody,
  roleBody,
  USER,
  userBody,
} from './fixtures.js';
import { apiError, type Recorded, type Reply, type Routes } from './harness.js';

export const ANA = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
export const BAO = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
/** The person who runs the command (`/v1/me`, fixtures `meBody`). */
export const OPERATOR_EMAIL = 'harry@example.test';
export const AGENTS_MD = '# Agent instructions\n';
export const AGENTS_SHA256 = createHash('sha256').update(AGENTS_MD).digest('hex');

const IDS: Readonly<Record<string, string>> = {
  'ana@example.test': ANA,
  'bao@example.test': BAO,
  [OPERATOR_EMAIL]: USER,
};

export const GITHUB: Readonly<Record<string, { id: number; type: string }>> = {
  'ana-gh': { id: 1001, type: 'User' },
  'bao-gh': { id: 1002, type: 'User' },
  'harry-gh': { id: 1003, type: 'User' },
  'deploy-bot': { id: 1004, type: 'Bot' },
};

export interface World {
  project: Record<string, unknown> | null;
  users: Record<string, unknown>[];
  identities: Record<string, Record<string, unknown>[]>;
  roles: Record<string, unknown>[];
  config: { version: number; yaml: string };
  agent: Record<string, unknown> | null;
}

export function emptyWorld(): World {
  return {
    project: null,
    users: [userBody({ id: USER, email: OPERATOR_EMAIL, display_name: 'Harry' }, true)],
    identities: {},
    roles: [],
    config: { version: 0, yaml: '' },
    agent: null,
  };
}

export const PROJECT_FILE = `format: 1
project:
  slug: pilot
  name: Pilot
  repository: harryforge/pilot-order-inventory
team:
  - email: ana@example.test
    name: Ana
    github_login: ana-gh
    roles: [person_a]
  - email: bao@example.test
    name: Bao
    github_login: bao-gh
    roles: [person_b, viewer]
agent:
  key: coder
  version: 1.0.0
  owner: ana@example.test
  model: claude-haiku-4-5-20251001
  instructions: AGENTS.md@v1
  instructions_file: AGENTS.md
  tools: [file_editor, terminal]
  max_autonomy: L2
  environments: [sandbox]
config:
  budget:
    warn_percent: 70
`;

/** Writes the project file and the agent's instructions next to it; returns the file's path. */
export async function writeProjectFile(dir: string, text = PROJECT_FILE): Promise<string> {
  await writeFile(join(dir, 'AGENTS.md'), AGENTS_MD);
  const file = join(dir, 'project.yaml');
  await writeFile(file, text);
  return file;
}

function configReply(world: World): Reply {
  return {
    status: 200,
    body: {
      project: PROJECT,
      version: world.config.version,
      config_yaml: world.config.yaml,
      config_hash: 'a'.repeat(64),
      override_sha256: null,
      updated_by: null,
      updated_at: null,
      warnings: [],
    },
  };
}

const body = (request: Recorded): Record<string, unknown> =>
  (request.body ?? {}) as Record<string, unknown>;

export function worldRoutes(world: World): Routes {
  const routes: Routes = {
    'GET /v1/me': { status: 200, body: meBody() },
    'GET /v1/admin/projects/pilot': () =>
      world.project ? { status: 200, body: world.project } : apiError(404, 'project_not_found'),
    'POST /v1/admin/projects': (request) => {
      const b = body(request);
      world.project = projectBody({
        name: String(b.name),
        repo_full_name: String(b.repo_full_name),
      });
      return { status: 201, body: world.project };
    },
    'PATCH /v1/admin/projects/pilot': (request) => {
      world.project = { ...world.project, ...body(request) };
      return { status: 200, body: world.project };
    },
    'GET /v1/admin/users': () => ({ status: 200, body: { items: world.users } }),
    'POST /v1/admin/users': (request) => {
      const b = body(request);
      const email = String(b.email);
      const user = userBody({ id: IDS[email], email, display_name: String(b.display_name) });
      world.users.push(user);
      return { status: 201, body: user };
    },
    'GET /v1/admin/projects/pilot/roles': () => ({ status: 200, body: { items: world.roles } }),
    'POST /v1/admin/projects/pilot/roles': (request) => {
      const b = body(request);
      const id = `cccccccc-cccc-4ccc-8ccc-${String(world.roles.length).padStart(12, '0')}`;
      const role = roleBody({ id, user_id: String(b.user_id), role: b.role as 'person_a' });
      world.roles.push(role);
      return { status: 201, body: role };
    },
    'GET /v1/admin/projects/pilot/config': () => configReply(world),
    'PUT /v1/admin/projects/pilot/config': (request) => {
      const b = body(request);
      if (b.expected_version !== world.config.version) return apiError(409, 'version_conflict');
      world.config = { version: world.config.version + 1, yaml: String(b.config_yaml) };
      return configReply(world);
    },
    'GET /v1/admin/agents/coder': () =>
      world.agent ? { status: 200, body: world.agent } : apiError(404, 'agent_not_found'),
    'POST /v1/admin/agents': (request) => {
      const b = body(request);
      world.agent = agentBody({
        owner_id: String(b.owner_id),
        instructions_sha256: String(b.instructions_sha256),
      });
      return { status: 201, body: world.agent };
    },
    'GET /v1/projects/pilot/ai-record': apiError(404, 'ai_record_not_found'),
  };
  for (const id of Object.values(IDS)) {
    routes[`PATCH /v1/admin/users/${id}`] = (request) => {
      const index = world.users.findIndex((user) => user.id === id);
      const user = { ...world.users[index], ...body(request) };
      world.users[index] = user;
      return { status: 200, body: user };
    };
    routes[`GET /v1/admin/users/${id}/identities`] = () => ({
      status: 200,
      body: { items: world.identities[id] ?? [] },
    });
    routes[`POST /v1/admin/users/${id}/identities`] = (request) => {
      const b = body(request);
      const identity = identityBody({
        user_id: id,
        external_id: String(b.external_id),
        external_login: String(b.external_login),
      });
      world.identities[id] = [...(world.identities[id] ?? []), identity];
      return { status: 201, body: identity };
    };
  }
  for (const [login, account] of Object.entries(GITHUB)) {
    routes[`GET /users/${login}`] = { status: 200, body: { login, ...account } };
  }
  return routes;
}

/** The requests that change something (every method but GET). */
export function writesOf(requests: readonly Recorded[]): string[] {
  return requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url.pathname}`);
}
