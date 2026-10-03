// `sdlc admin …` through the API (task B13, ADR-M37 §2.7–§2.8). These are user commands: they use
// the login of `sdlc login` (or SDLC_API_URL and SDLC_API_TOKEN in CI) and the B04 client
// (ADR-M36). The caller needs the tenant role `tenant_admin`, or the project role `admin` for a
// project's roles and configuration; the agent register follows handbook Ch.20. The operator's
// commands on the server are `sdlc ops …` (ops.ts).
import { t } from '@sdlc/messages';

import { parseCommand, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { AGENT_COMMANDS } from './admin-agents.js';
import type { AdminApiCommand } from './admin-call.js';
import { PROJECT_COMMANDS } from './admin-projects.js';
import { USER_COMMANDS } from './admin-users.js';

/** Groups of `sdlc admin` that go through the API. */
export const ADMIN_API_GROUPS = [
  'project',
  'user',
  'identity',
  'role',
  'config',
  'tenant-admin',
  'token',
  'agent',
] as const;

const COMMANDS: Readonly<Record<string, AdminApiCommand>> = {
  ...PROJECT_COMMANDS,
  ...USER_COMMANDS,
  ...AGENT_COMMANDS,
};

export function isAdminApiGroup(group: string | undefined): boolean {
  return group !== undefined && (ADMIN_API_GROUPS as readonly string[]).includes(group);
}

/** `args` starts after `admin`: `<group> <command> [options]`. */
export async function runAdminApi(args: readonly string[], ctx: CliContext): Promise<number> {
  const [group, command, ...rest] = args;
  const key = `${group ?? ''} ${command ?? ''}`;
  const spec = Object.hasOwn(COMMANDS, key) ? COMMANDS[key] : undefined;
  const parsed = spec ? parseCommand(rest, spec.options) : undefined;
  if (!spec || !parsed || !spec.required.every((name) => typeof parsed.values[name] === 'string')) {
    ctx.stderr(t('cli.admin.api.usage'));
    return EXIT.usage;
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, (client) => spec.run({ ctx, client, values: parsed.values, json }));
}
