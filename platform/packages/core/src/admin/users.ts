// Users and their Git host identities (task B13 AC2, AC3, ADR-M37 §2.3). Tenant admins only.
// Audit events hold IDs and codes only: never a name, an e-mail address, an account ID or a login.
import { isUuid } from '../db/tenant-id.js';
import type { UserUpdate } from '../db/repositories/users.js';
import type { User, UserIdentity } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { assertTenantAdmin, auditActor, type AdminActor } from './actor.js';
import { AdminError } from './errors.js';
import { alreadyExists } from './projects.js';
import { assertAdminRemains } from './tenant-roles.js';
import {
  checkEmail,
  checkName,
  checkPattern,
  EXTERNAL_ID_PATTERN,
  EXTERNAL_LOGIN_PATTERN,
} from './validation.js';

export async function listUsers(scope: TenantScope, actor: AdminActor): Promise<User[]> {
  await assertTenantAdmin(scope, actor);
  return scope.users.list();
}

export async function showUser(
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
): Promise<User> {
  await assertTenantAdmin(scope, actor);
  return findUser(scope, userId);
}

export async function createUser(
  scope: TenantScope,
  actor: AdminActor,
  input: { readonly email: string; readonly displayName: string },
): Promise<User> {
  const values = {
    email: checkEmail(input.email),
    display_name: checkName('display_name', input.displayName),
    status: 'active' as const,
  };
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const user = await tx.users.create(values).catch(alreadyExists);
    await tx.audit.append({
      action: 'user.created',
      ...auditActor(actor),
      entityId: user.id,
      payload: {},
    });
    return user;
  });
}

export async function updateUser(
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  changes: { readonly email?: string; readonly displayName?: string },
): Promise<User> {
  const update: { -readonly [K in keyof UserUpdate]: UserUpdate[K] } = {};
  if (changes.email !== undefined) update.email = checkEmail(changes.email);
  if (changes.displayName !== undefined) {
    update.display_name = checkName('display_name', changes.displayName);
  }
  if (Object.keys(update).length === 0) {
    throw new AdminError('invalid_value', 'nothing to change', { field: 'body' });
  }
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const user = await findUser(tx, userId);
    const updated = await tx.users.update(user.id, update).catch(alreadyExists);
    if (!updated) throw new AdminError('user_not_found', 'user not found');
    await tx.audit.append({
      action: 'user.updated',
      ...auditActor(actor),
      entityId: updated.id,
      payload: {},
    });
    return updated;
  });
}

/**
 * Disables or enables a user. A disabled user's tokens stop working at once (the API checks the
 * user on every request, ADR-M26 §2.3). Nobody disables themselves, and the last active tenant
 * admin cannot be disabled.
 */
export async function setUserActive(
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  active: boolean,
): Promise<User> {
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const user = await findUser(tx, userId);
    if (!active && actor.type === 'human' && actor.userId === user.id) {
      throw new AdminError('self_action', 'nobody disables themselves');
    }
    const status = active ? 'active' : 'disabled';
    if (user.status === status) return user;
    if (!active) await assertAdminRemains(tx, [user.id]);
    const changed = await tx.users.setStatus(user.id, status);
    if (!changed) throw new AdminError('user_not_found', 'user not found');
    await tx.audit.append({
      action: active ? 'user.enabled' : 'user.disabled',
      ...auditActor(actor),
      entityId: changed.id,
      payload: {},
    });
    return changed;
  });
}

export async function listIdentities(
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  includeUnlinked = false,
): Promise<UserIdentity[]> {
  await assertTenantAdmin(scope, actor);
  const user = await findUser(scope, userId);
  return scope.userIdentities.listForUser(user.id, { includeUnlinked });
}

export interface LinkIdentity {
  readonly provider?: 'github';
  /** The numeric account ID (QUESTIONS #45). */
  readonly externalId: string;
  /** The current login, shown only. */
  readonly externalLogin: string;
}

/**
 * Links a Git host account to an active user. The account is matched by its numeric ID only; the
 * login is for display. An account linked to anyone in the tenant is refused (`already_exists`):
 * unlink it first.
 */
export async function linkIdentity(
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  input: LinkIdentity,
): Promise<UserIdentity> {
  const provider = input.provider ?? 'github';
  if (provider !== 'github') {
    throw new AdminError('invalid_value', 'unsupported Git host', { field: 'provider' });
  }
  const externalId = checkPattern('external_id', input.externalId, EXTERNAL_ID_PATTERN);
  const externalLogin = checkPattern('external_login', input.externalLogin, EXTERNAL_LOGIN_PATTERN);
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const user = await findUser(tx, userId);
    if (user.status !== 'active') throw new AdminError('user_not_active', 'user is disabled');
    const identity = await tx.userIdentities
      .link({
        user_id: user.id,
        provider,
        external_id: externalId,
        external_login: externalLogin,
      })
      .catch(alreadyExists);
    await tx.audit.append({
      action: 'identity.linked',
      ...auditActor(actor),
      entityId: identity.id,
      payload: { user_id: identity.user_id, provider: identity.provider },
    });
    return identity;
  });
}

export async function unlinkIdentity(
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  identityId: string,
  now?: Date,
): Promise<UserIdentity> {
  return scope.transaction(async (tx) => {
    await assertTenantAdmin(tx, actor);
    const user = await findUser(tx, userId);
    const identity = isUuid(identityId) ? await tx.userIdentities.getById(identityId) : undefined;
    if (identity?.user_id !== user.id) {
      throw new AdminError('identity_not_found', 'no linked identity with this ID');
    }
    const unlinked = await tx.userIdentities.unlink(identity.id, now);
    if (!unlinked) throw new AdminError('identity_not_found', 'no linked identity with this ID');
    await tx.audit.append({
      action: 'identity.unlinked',
      ...auditActor(actor),
      entityId: unlinked.id,
      payload: { user_id: unlinked.user_id, provider: unlinked.provider },
    });
    return unlinked;
  });
}

/** The user by ID in this tenant; `user_not_found` otherwise. */
export async function findUser(scope: TenantScope, userId: string): Promise<User> {
  const user = isUuid(userId) ? await scope.users.getById(userId) : undefined;
  if (!user) throw new AdminError('user_not_found', 'user not found');
  return user;
}
