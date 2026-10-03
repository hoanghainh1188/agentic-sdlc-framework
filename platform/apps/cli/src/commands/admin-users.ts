// `sdlc admin user|identity|tenant-admin …` through the API (task B13 AC2, AC3; ADR-M37 §2.7).
// `--user` takes a user ID or an e-mail address (looked up in the tenant's user list).
import { t } from '@sdlc/messages';

import {
  adminIdentityListSchema,
  adminIdentitySchema,
  adminTenantRoleListSchema,
  adminTenantRoleSchema,
  adminUserListSchema,
  adminUserSchema,
  type AdminIdentityView,
  type AdminTenantRoleView,
  type AdminUserView,
} from '../api/schemas.js';
import { segment } from '../api/session.js';
import { say, show } from '../output.js';
import {
  opt,
  output,
  resolveUser,
  str,
  type AdminApiCommand,
  type AdminCall,
} from './admin-call.js';

const user = { user: { type: 'string' } } as const;
const all = { all: { type: 'boolean', default: false } } as const;

const userPath = async (call: AdminCall): Promise<string> =>
  `/v1/admin/users/${segment(await resolveUser(call, str(call.values, 'user')))}`;

const setActive = (active: boolean): AdminApiCommand => ({
  options: user,
  required: ['user'],
  run: async (call) => {
    const changed = await call.client.post(
      `${await userPath(call)}/${active ? 'enable' : 'disable'}`,
      adminUserSchema,
    );
    return output(call, changed, () => sayUser(call, changed));
  },
});

export const USER_COMMANDS: Readonly<Record<string, AdminApiCommand>> = {
  'user create': {
    options: { email: { type: 'string' }, name: { type: 'string' } },
    required: ['email', 'name'],
    run: async (call) => {
      const created = await call.client.post('/v1/admin/users', adminUserSchema, {
        email: str(call.values, 'email'),
        display_name: str(call.values, 'name'),
      });
      return output(call, created, () => sayUser(call, created));
    },
  },
  'user list': {
    options: {},
    required: [],
    run: async (call) => {
      const list = await call.client.get('/v1/admin/users', adminUserListSchema);
      return output(call, list, () => {
        if (list.items.length === 0) say(call.ctx, 'cli.admin.api.none');
        for (const item of list.items) say(call.ctx, 'cli.admin.user.line', userParams(item));
      });
    },
  },
  'user show': {
    options: user,
    required: ['user'],
    run: async (call) => {
      const found = await call.client.get(await userPath(call), adminUserSchema);
      return output(call, found, () => sayUser(call, found));
    },
  },
  'user update': {
    options: { ...user, email: { type: 'string' }, name: { type: 'string' } },
    required: ['user'],
    run: async (call) => {
      const email = opt(call.values, 'email');
      const name = opt(call.values, 'name');
      const updated = await call.client.patch(await userPath(call), adminUserSchema, {
        ...(email === undefined ? {} : { email }),
        ...(name === undefined ? {} : { display_name: name }),
      });
      return output(call, updated, () => sayUser(call, updated));
    },
  },
  'user disable': setActive(false),
  'user enable': setActive(true),
  'identity link': {
    options: { ...user, 'github-id': { type: 'string' }, 'github-login': { type: 'string' } },
    required: ['user', 'github-id', 'github-login'],
    run: async (call) => {
      const linked = await call.client.post(
        `${await userPath(call)}/identities`,
        adminIdentitySchema,
        {
          provider: 'github',
          external_id: str(call.values, 'github-id'),
          external_login: str(call.values, 'github-login'),
        },
      );
      return output(call, linked, () =>
        say(call.ctx, 'cli.admin.identity.saved', identityParams(linked)),
      );
    },
  },
  'identity list': {
    options: { ...user, ...all },
    required: ['user'],
    run: async (call) => {
      const list = await call.client.get(
        `${await userPath(call)}/identities`,
        adminIdentityListSchema,
        { include_unlinked: call.values.all === true ? 'true' : undefined },
      );
      return output(call, list, () => {
        if (list.items.length === 0) say(call.ctx, 'cli.admin.api.none');
        for (const item of list.items) {
          say(call.ctx, 'cli.admin.identity.line', identityParams(item));
        }
      });
    },
  },
  'identity unlink': {
    options: { ...user, id: { type: 'string' } },
    required: ['user', 'id'],
    run: async (call) => {
      const unlinked = await call.client.delete(
        `${await userPath(call)}/identities/${segment(str(call.values, 'id'))}`,
        adminIdentitySchema,
      );
      return output(call, unlinked, () =>
        say(call.ctx, 'cli.admin.identity.saved', identityParams(unlinked)),
      );
    },
  },
  'tenant-admin grant': {
    options: user,
    required: ['user'],
    run: async (call) => {
      const granted = await call.client.post('/v1/admin/tenant-admins', adminTenantRoleSchema, {
        user_id: await resolveUser(call, str(call.values, 'user')),
      });
      return output(call, granted, () =>
        say(call.ctx, 'cli.admin.tenant_admin.saved', tenantRoleParams(granted)),
      );
    },
  },
  'tenant-admin list': {
    options: all,
    required: [],
    run: async (call) => {
      const list = await call.client.get('/v1/admin/tenant-admins', adminTenantRoleListSchema, {
        include_revoked: call.values.all === true ? 'true' : undefined,
      });
      return output(call, list, () => {
        if (list.items.length === 0) say(call.ctx, 'cli.admin.api.none');
        for (const item of list.items) {
          say(call.ctx, 'cli.admin.tenant_admin.line', tenantRoleParams(item));
        }
      });
    },
  },
  'tenant-admin revoke': {
    options: { id: { type: 'string' } },
    required: ['id'],
    run: async (call) => {
      const revoked = await call.client.delete(
        `/v1/admin/tenant-admins/${segment(str(call.values, 'id'))}`,
        adminTenantRoleSchema,
      );
      return output(call, revoked, () =>
        say(call.ctx, 'cli.admin.tenant_admin.saved', tenantRoleParams(revoked)),
      );
    },
  },
};

function userParams(item: AdminUserView): Record<string, string> {
  return {
    id: item.id,
    email: item.email,
    name: item.display_name,
    status: item.status,
    admin: item.tenant_admin ? t('cli.admin.user.tenant_admin_flag') : '-',
  };
}

function sayUser(call: AdminCall, item: AdminUserView): void {
  say(call.ctx, 'cli.admin.user.saved', userParams(item));
}

function identityParams(item: AdminIdentityView): Record<string, string> {
  return {
    id: item.id,
    user_id: item.user_id,
    provider: item.provider,
    external_id: item.external_id,
    login: item.external_login,
    unlinked: show(item.unlinked_at),
  };
}

function tenantRoleParams(item: AdminTenantRoleView): Record<string, string> {
  return {
    id: item.id,
    role: item.role,
    user_id: item.user_id,
    revoked: show(item.revoked_at),
  };
}
