// `sdlc admin project apply --file project.yaml` (task V17 AC1–AC6, QUESTIONS #617) against an
// in-memory platform and GitHub: a new project, a second run, a changed file, M21 within the file
// and against the bindings already held, an unknown or bot GitHub login, `--dry-run`, the
// confirmation, and that it never approves the agent, writes the AI record or issues a token.
import { join } from 'node:path';

import { projectFileSchema } from '@sdlc/api-schemas';
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { readProjectFile } from '../../apps/cli/src/commands/project-apply/file.js';
import {
  githubApiUrl,
  lookupGithubLogin,
} from '../../apps/cli/src/commands/project-apply/github.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { USER } from './fixtures.js';
import { useHarness, type Harness } from './harness.js';
import {
  AGENTS_SHA256,
  ANA,
  BAO,
  emptyWorld,
  PROJECT_FILE,
  worldRoutes,
  writeProjectFile,
  writesOf,
  type World,
} from './project-apply-world.js';

const harness = useHarness();

const NEW_PROJECT_WRITES = [
  'POST /v1/admin/projects',
  'POST /v1/admin/users',
  'POST /v1/admin/users',
  `POST /v1/admin/users/${ANA}/identities`,
  `POST /v1/admin/users/${BAO}/identities`,
  'POST /v1/admin/projects/pilot/roles',
  'POST /v1/admin/projects/pilot/roles',
  'POST /v1/admin/projects/pilot/roles',
  'POST /v1/admin/agents',
  'PUT /v1/admin/projects/pilot/config',
];

interface Run {
  readonly h: Harness;
  readonly code: number;
}

async function apply(
  world: World,
  args: readonly string[] = ['--yes'],
  text = PROJECT_FILE,
  options: { tty?: boolean; hidden?: string } = {},
): Promise<Run> {
  const h = await harness({ routes: worldRoutes(world), ...options });
  const file = await writeProjectFile(h.home, text);
  const code = await h.run(['admin', 'project', 'apply', '--file', file, ...args]);
  return { h, code };
}

const edit = (from: string, to: string): string => {
  expect(PROJECT_FILE).toContain(from);
  return PROJECT_FILE.replace(from, to);
};

describe('sdlc admin project apply (V17)', () => {
  it('AC1: the file schema is strict, so no token or secret field can be added', () => {
    const file = parse(PROJECT_FILE) as Record<string, unknown>;
    expect(projectFileSchema.safeParse(file).success).toBe(true);
    expect(projectFileSchema.safeParse({ ...file, token: 'x' }).success).toBe(false);
    const team = file.team as Record<string, unknown>[];
    const withSecret = { ...file, team: [{ ...team[0], password: 'x' }, team[1]] };
    expect(projectFileSchema.safeParse(withSecret).success).toBe(false);
    expect(projectFileSchema.safeParse({ ...file, format: 2 }).success).toBe(false);
  });

  it('AC1: a refused file sends no request at all', async () => {
    const { h, code } = await apply(emptyWorld(), ['--yes'], `${PROJECT_FILE}api_token: abc\n`);
    expect(code).toBe(EXIT.failed);
    expect(h.requests).toEqual([]);
    expect(h.err).toContain(t('cli.admin.apply.field', { field: 'api_token' }));
    expect(h.err.at(-1)).toBe(t('cli.admin.apply.refused'));
  });

  it('AC2, AC4, AC5: a new project, one call per change, then each person’s commands', async () => {
    const world = emptyWorld();
    const { h, code } = await apply(world);
    expect(code).toBe(EXIT.ok);
    expect(writesOf(h.requests)).toEqual(NEW_PROJECT_WRITES);
    // The numeric ID from GitHub is what the identity carries (R037); the login only helps.
    const links = h.requests.filter(
      (r) => r.url.pathname.endsWith('/identities') && r.method === 'POST',
    );
    expect(links.map((r) => r.body)).toEqual([
      { provider: 'github', external_id: '1001', external_login: 'ana-gh' },
      { provider: 'github', external_id: '1002', external_login: 'bao-gh' },
    ]);
    expect(h.out).toContain(
      t('cli.admin.apply.github_line', { email: 'ana@example.test', login: 'ana-gh', id: '1001' }),
    );
    const agent = h.requests.find((r) => r.url.pathname === '/v1/admin/agents');
    expect(agent?.body).toMatchObject({ owner_id: ANA, instructions_sha256: AGENTS_SHA256 });
    const config = h.requests.find((r) => r.method === 'PUT');
    expect(config?.body).toEqual({
      expected_version: 0,
      config_yaml: 'budget:\n  warn_percent: 70\n',
    });
    // AC5: never an approval, the AI record or a token.
    expect(writesOf(h.requests).filter((w) => /approvals|ai-record|tokens/.test(w))).toEqual([]);
    for (const line of [
      t('cli.admin.apply.todo.token_issue', { email: 'ana@example.test' }),
      t('cli.admin.apply.todo.token_issue', { email: 'bao@example.test' }),
      t('cli.admin.apply.todo.approve_owner', { key: 'coder' }),
      t('cli.admin.apply.todo.approve_person_b', { key: 'coder' }),
      t('cli.admin.apply.todo.ai_record', { project: 'pilot' }),
      t('cli.admin.apply.applied', { count: NEW_PROJECT_WRITES.length }),
    ]) {
      expect(h.out).toContain(line);
    }
  });

  it('AC4: a second run with the same file changes nothing', async () => {
    const world = emptyWorld();
    await apply(world);
    const { h, code } = await apply(world, []);
    expect(code).toBe(EXIT.ok);
    expect(writesOf(h.requests)).toEqual([]);
    expect(h.out).toContain(t('cli.admin.apply.nothing', { project: 'pilot' }));
  });

  it('AC4: a changed file shows the difference and sends only those changes', async () => {
    const world = emptyWorld();
    await apply(world);
    const changed = edit('name: Pilot\n', 'name: Pilot 2\n')
      .replace('name: Bao\n', 'name: Bao Tran\n')
      .replace('roles: [person_b, viewer]', 'roles: [person_b]')
      .replace('version: 1.0.0', 'version: 1.1.0')
      .replace('warn_percent: 70', 'warn_percent: 80');
    const { h, code } = await apply(world, ['--yes'], changed);
    expect(code).toBe(EXIT.ok);
    expect(writesOf(h.requests)).toEqual([
      'PATCH /v1/admin/projects/pilot',
      `PATCH /v1/admin/users/${BAO}`,
      'PUT /v1/admin/projects/pilot/config',
    ]);
    expect(h.requests.find((r) => r.method === 'PUT')?.body).toMatchObject({ expected_version: 1 });
    expect(h.out).toContain(
      t('cli.admin.apply.change.project_update', {
        email: 'pilot',
        field: 'name',
        from: 'Pilot',
        to: 'Pilot 2',
      }),
    );
    // A role the file no longer lists is shown, never revoked; an agent change is shown only.
    expect(h.out).toContain(
      t('cli.admin.apply.note.role_extra', { email: 'bao@example.test', role: 'viewer' }),
    );
    expect(h.out).toContain(
      t('cli.admin.apply.note.agent_differs', {
        key: 'coder',
        field: 'version',
        from: '1.0.0',
        to: '1.1.0',
      }),
    );
    expect(h.out).toContain(t('cli.admin.apply.todo.agent_update', { key: 'coder' }));
  });

  it('AC3: Person A and Person B as the same person in the file: refused, nothing written', async () => {
    const { h, code } = await apply(
      emptyWorld(),
      ['--yes'],
      edit('roles: [person_a]', 'roles: [person_a, person_b]'),
    );
    expect(code).toBe(EXIT.failed);
    expect(writesOf(h.requests)).toEqual([]);
    expect(h.err).toContain(
      t('cli.admin.apply.conflicting_roles', {
        email: 'ana@example.test',
        roles: 'person_a + person_b',
        project: 'pilot',
      }),
    );
  });

  it('AC3: a role that clashes with a binding already in the database: refused', async () => {
    const world = emptyWorld();
    await apply(world);
    // Ana is Person A already; the new file makes her Person B and Bao a viewer only.
    const changed = edit('roles: [person_a]', 'roles: [person_b]').replace(
      'roles: [person_b, viewer]',
      'roles: [viewer]',
    );
    const { h, code } = await apply(world, ['--yes'], changed);
    expect(code).toBe(EXIT.failed);
    expect(writesOf(h.requests)).toEqual([]);
    expect(h.err).toContain(
      t('cli.admin.apply.conflicting_roles', {
        email: 'ana@example.test',
        roles: 'person_a + person_b',
        project: 'pilot',
      }),
    );
  });

  it('AC3: the pairs of access.conflicting_roles and unknown roles are refused too', async () => {
    const { h, code } = await apply(
      emptyWorld(),
      ['--yes'],
      edit('roles: [person_b, viewer]', 'roles: [person_b, second_approver, reviewer]'),
    );
    expect(code).toBe(EXIT.failed);
    expect(h.requests).toEqual([]);
    expect(h.err).toContain(
      t('cli.admin.apply.unknown_role', { email: 'bao@example.test', role: 'reviewer' }),
    );
    const second = await apply(
      emptyWorld(),
      ['--yes'],
      edit('roles: [person_b, viewer]', 'roles: [person_b, second_approver]'),
    );
    expect(second.code).toBe(EXIT.failed);
    expect(writesOf(second.h.requests)).toEqual([]);
    expect(second.h.err).toContain(
      t('cli.admin.apply.conflicting_roles', {
        email: 'bao@example.test',
        roles: 'person_b + second_approver',
        project: 'pilot',
      }),
    );
  });

  it('AC2: an unknown GitHub login or a bot account: refused, nothing written', async () => {
    const unknown = await apply(emptyWorld(), ['--yes'], edit('ana-gh', 'ana-typo'));
    expect(unknown.code).toBe(EXIT.failed);
    expect(writesOf(unknown.h.requests)).toEqual([]);
    expect(unknown.h.err).toContain(t('cli.admin.apply.github_unknown', { login: 'ana-typo' }));
    const bot = await apply(emptyWorld(), ['--yes'], edit('bao-gh', 'deploy-bot'));
    expect(bot.code).toBe(EXIT.failed);
    expect(writesOf(bot.h.requests)).toEqual([]);
    expect(bot.h.err).toContain(t('cli.admin.apply.github_not_a_person', { login: 'deploy-bot' }));
  });

  it('AC2: an account linked to another GitHub ID is refused, never re-linked', async () => {
    const world = emptyWorld();
    await apply(world);
    const { h, code } = await apply(
      world,
      ['--yes'],
      edit('github_login: ana-gh', 'github_login: harry-gh'),
    );
    expect(code).toBe(EXIT.failed);
    expect(writesOf(h.requests)).toEqual([]);
    expect(h.err).toContain(
      t('cli.admin.apply.identity_differs', {
        email: 'ana@example.test',
        linked: '1001',
        found: '1003',
        login: 'harry-gh',
      }),
    );
  });

  it('AC4: --dry-run shows the changes and writes nothing', async () => {
    const { h, code } = await apply(emptyWorld(), ['--dry-run']);
    expect(code).toBe(EXIT.ok);
    expect(writesOf(h.requests)).toEqual([]);
    expect(h.out).toContain(t('cli.admin.apply.plan_header', { project: 'pilot', count: 10 }));
    expect(h.out).toContain(t('cli.admin.apply.dry_run'));
  });

  it('AC2: the operator confirms; without a terminal or without "yes" nothing is written', async () => {
    const noTerminal = await apply(emptyWorld(), []);
    expect(noTerminal.code).toBe(EXIT.usage);
    expect(writesOf(noTerminal.h.requests)).toEqual([]);
    expect(noTerminal.h.err).toContain(t('cli.admin.apply.needs_terminal'));
    const no = await apply(emptyWorld(), [], PROJECT_FILE, { tty: true, hidden: 'no' });
    expect(no.code).toBe(EXIT.failed);
    expect(writesOf(no.h.requests)).toEqual([]);
    const yes = await apply(emptyWorld(), [], PROJECT_FILE, { tty: true, hidden: 'yes' });
    expect(yes.code).toBe(EXIT.ok);
    expect(writesOf(yes.h.requests)).toEqual(NEW_PROJECT_WRITES);
  });

  it('AC5: a role for the operator is left to another admin, never self-granted', async () => {
    const withOperator = PROJECT_FILE.replace(
      'agent:\n',
      '  - email: harry@example.test\n    name: Harry\n    github_login: harry-gh\n    roles: [admin]\nagent:\n',
    );
    const world = emptyWorld();
    const { h, code } = await apply(world, ['--yes'], withOperator);
    expect(code).toBe(EXIT.ok);
    const grants = h.requests.filter(
      (r) => r.method === 'POST' && r.url.pathname.endsWith('/roles'),
    );
    expect(grants.map((r) => (r.body as { user_id: string }).user_id)).not.toContain(USER);
    expect(h.out).toContain(
      t('cli.admin.apply.note.role_self', { email: 'harry@example.test', role: 'admin' }),
    );
    expect(h.out).toContain(
      t('cli.admin.apply.todo.role_by_other', {
        project: 'pilot',
        email: 'harry@example.test',
        role: 'admin',
      }),
    );
  });

  it('AC4: a failure part-way says how far it got; running again finishes the job', async () => {
    const world = emptyWorld();
    const routes = worldRoutes(world);
    const h = await harness({
      routes: {
        ...routes,
        'POST /v1/admin/agents': {
          status: 422,
          body: { error: { code: 'invalid_value', message: 'x' } },
        },
      },
    });
    const file = await writeProjectFile(h.home);
    expect(await h.run(['admin', 'project', 'apply', '--file', file, '--yes'])).toBe(EXIT.failed);
    expect(h.err).toContain(t('cli.admin.apply.stopped', { number: 9, count: 10 }));
    const again = await apply(world);
    expect(again.code).toBe(EXIT.ok);
    expect(writesOf(again.h.requests)).toEqual([
      'POST /v1/admin/agents',
      'PUT /v1/admin/projects/pilot/config',
    ]);
  });

  it('prints a JSON report with --json', async () => {
    const { h, code } = await apply(emptyWorld(), ['--dry-run', '--json']);
    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(report).toMatchObject({ project: 'pilot', dry_run: true, applied: false });
    expect((report.github as unknown[]).length).toBe(2);
    expect((report.changes as unknown[]).length).toBe(10);
  });
});

describe('the GitHub lookup of project apply (V17 AC2)', () => {
  const reply =
    (status: number, body?: unknown): typeof fetch =>
    () =>
      Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));

  it('takes https:// only, without a user name or password', () => {
    expect(githubApiUrl({})).toBe('https://api.github.com');
    expect(githubApiUrl({ SDLC_GITHUB_API_URL: 'https://ghe.example.test/api/v3/' })).toBe(
      'https://ghe.example.test/api/v3',
    );
    expect(githubApiUrl({ SDLC_GITHUB_API_URL: 'http://ghe.example.test' })).toBeUndefined();
    expect(githubApiUrl({ SDLC_GITHUB_API_URL: 'https://u:p@ghe.example.test' })).toBeUndefined();
  });

  it('refuses a redirect (a renamed login), another login and a malformed answer', async () => {
    const base = 'https://api.github.com';
    expect(await lookupGithubLogin(reply(301), base, 'old')).toEqual({ kind: 'failed' });
    expect(
      await lookupGithubLogin(reply(200, { id: 7, login: 'other', type: 'User' }), base, 'ana'),
    ).toEqual({ kind: 'failed' });
    expect(await lookupGithubLogin(reply(200, { id: 'x' }), base, 'ana')).toEqual({
      kind: 'failed',
    });
    expect(
      await lookupGithubLogin(reply(200, { id: 7, login: 'Ana', type: 'User' }), base, 'ana'),
    ).toEqual({ kind: 'found', id: '7', login: 'Ana' });
  });
});

describe('platform/deploy/project.example.yaml (the example the docs link to)', () => {
  it('is a valid project file as the command reads it', async () => {
    const example = join(__dirname, '..', '..', 'deploy', 'project.example.yaml');
    const read = await readProjectFile(example);
    expect(read.ok, JSON.stringify(read)).toBe(true);
  });
});
