import type { Project, TenantInsert } from '../schema.js';
import { TenantRepository } from './base.js';

export class ProjectRepository extends TenantRepository {
  create(input: TenantInsert<'projects'>): Promise<Project> {
    return this.run(
      this.db
        .insertInto('projects')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string): Promise<Project | undefined> {
    return this.run(
      this.db
        .selectFrom('projects')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  getBySlug(slug: string): Promise<Project | undefined> {
    return this.run(
      this.db
        .selectFrom('projects')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('slug', '=', slug)
        .executeTakeFirst(),
    );
  }

  list(): Promise<Project[]> {
    return this.run(
      this.db
        .selectFrom('projects')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .orderBy('slug')
        .execute(),
    );
  }
}
