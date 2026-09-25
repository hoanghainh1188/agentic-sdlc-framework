import type { RoleBinding, TenantInsert } from '../schema.js';
import { TenantRepository } from './base.js';

export class RoleBindingRepository extends TenantRepository {
  grant(input: TenantInsert<'role_bindings'>): Promise<RoleBinding> {
    return this.run(
      this.db
        .insertInto('role_bindings')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  listForProject(projectId: string): Promise<RoleBinding[]> {
    return this.run(
      this.db
        .selectFrom('role_bindings')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('project_id', '=', projectId)
        .orderBy('role')
        .orderBy('user_id')
        .execute(),
    );
  }

  listForUser(userId: string): Promise<RoleBinding[]> {
    return this.run(
      this.db
        .selectFrom('role_bindings')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', userId)
        .orderBy('project_id')
        .orderBy('role')
        .execute(),
    );
  }
}
