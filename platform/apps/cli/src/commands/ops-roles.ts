// `sdlc ops tenant-admin grant|revoke|list` and `sdlc ops role grant|revoke` (task B13,
// QUESTIONS #151, ADR-M37 §2.2): role changes on the server, for a tenant with one admin (nobody
// grants a role to themselves through the API) or to recover a tenant that lost its admins.
// Audited as actor `system`. The other rules still hold: conflicting roles (rule M21), active
// users only, the last tenant admin is never removed.
import { parseArgs } from 'node:util';

import {
  AdminError,
  grantProjectRole,
  grantTenantRole,
  listTenantRoles,
  revokeProjectRole,
  revokeTenantRole,
  SYSTEM_ACTOR,
  type TenantScope,
} from '@sdlc/core';
import { t } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';

type Values = Record<string, string | boolean | undefined>;

const COMMON = { tenant: { type: 'string' }, json: { type: 'boolean', default: false } } as const;

const SPECS = {
  'tenant-admin grant': { ...COMMON, email: { type: 'string' } },
  'tenant-admin revoke': { ...COMMON, id: { type: 'string' } },
  'tenant-admin list': COMMON,
  'role grant': {
    ...COMMON,
    project: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string' },
  },
  'role revoke': { ...COMMON, project: { type: 'string' }, id: { type: 'string' } },
} as const;
export type RoleCommand = keyof typeof SPECS;

const REQUIRED: Readonly<Record<RoleCommand, readonly string[]>> = {
  'tenant-admin grant': ['tenant', 'email'],
  'tenant-admin revoke': ['tenant', 'id'],
  'tenant-admin list': ['tenant'],
  'role grant': ['tenant', 'project', 'email', 'role'],
  'role revoke': ['tenant', 'project', 'id'],
};

/** Parses `args` after `ops` (`tenant-admin …` or `role …`). Undefined: print the usage. */
export function parseRoleCommand(
  args: readonly string[],
): { command: RoleCommand; values: Values } | undefined {
  const [group, command, ...rest] = args;
  const key = `${group ?? ''} ${command ?? ''}`;
  if (!Object.hasOwn(SPECS, key)) return undefined;
  const name = key as RoleCommand;
  try {
    const { values } = parseArgs({
      args: rest,
      options: SPECS[name],
      strict: true,
      allowPositionals: false,
    });
    const found = values as Values;
    return REQUIRED[name].every((k) => typeof found[k] === 'string')
      ? { command: name, values: found }
      : undefined;
  } catch {
    return undefined;
  }
}

const str = (values: Values, key: string): string => String(values[key]);

export async function runRoleCommand(
  scope: TenantScope,
  command: RoleCommand,
  values: Values,
  ctx: CliContext,
): Promise<number> {
  try {
    const result = await HANDLERS[command](scope, values, ctx);
    if (result === undefined) return EXIT.usage;
    ctx.stdout(values.json === true ? JSON.stringify(result.json, null, 2) : result.text);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof AdminError) {
      ctx.stderr(t('cli.ops.refused', { code: error.code, reason: error.extra.reason ?? '-' }));
      return error.code === 'invalid_value' ? EXIT.usage : EXIT.failed;
    }
    throw error;
  }
}

interface Printed {
  readonly json: unknown;
  readonly text: string;
}

type Handler = (
  scope: TenantScope,
  values: Values,
  ctx: CliContext,
) => Promise<Printed | undefined>;

async function userId(scope: TenantScope, values: Values, ctx: CliContext) {
  const user = await scope.users.getByEmail(str(values, 'email'));
  if (!user) ctx.stderr(t('cli.admin.user_not_found'));
  return user?.id;
}

const HANDLERS: Readonly<Record<RoleCommand, Handler>> = {
  'tenant-admin grant': async (scope, values, ctx) => {
    const id = await userId(scope, values, ctx);
    if (id === undefined) return undefined;
    const binding = await grantTenantRole(scope, SYSTEM_ACTOR, { userId: id });
    return {
      json: binding,
      text: t('cli.ops.tenant_admin.granted', { id: binding.id, user_id: binding.user_id }),
    };
  },
  'tenant-admin revoke': async (scope, values) => {
    const binding = await revokeTenantRole(scope, SYSTEM_ACTOR, str(values, 'id'));
    return { json: binding, text: t('cli.ops.tenant_admin.revoked', { id: binding.id }) };
  },
  'tenant-admin list': async (scope) => {
    const bindings = await listTenantRoles(scope, SYSTEM_ACTOR);
    return {
      json: bindings,
      text:
        bindings.length === 0
          ? t('cli.admin.api.none')
          : bindings
              .map((b) => t('cli.ops.tenant_admin.line', { id: b.id, user_id: b.user_id }))
              .join('\n'),
    };
  },
  'role grant': async (scope, values, ctx) => {
    const id = await userId(scope, values, ctx);
    if (id === undefined) return undefined;
    const role = str(values, 'role');
    const binding = await grantProjectRole(scope, SYSTEM_ACTOR, str(values, 'project'), {
      userId: id,
      role: role as Parameters<typeof grantProjectRole>[3]['role'],
    });
    return {
      json: binding,
      text: t('cli.ops.role.granted', { id: binding.id, role, project: str(values, 'project') }),
    };
  },
  'role revoke': async (scope, values) => {
    const binding = await revokeProjectRole(
      scope,
      SYSTEM_ACTOR,
      str(values, 'project'),
      str(values, 'id'),
    );
    return { json: binding, text: t('cli.ops.role.revoked', { id: binding.id }) };
  },
};
