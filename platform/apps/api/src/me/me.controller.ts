// `GET /v1/me`: who the token belongs to (for `sdlc login`, task B04). Only the caller's own data.
import { Controller, Get } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';

@Controller('v1/me')
export class MeController {
  @Get()
  async me(@CurrentPrincipal() p: Principal): Promise<Record<string, unknown>> {
    const [user, bindings, projects, tenantAdmin] = await Promise.all([
      p.scope.users.getById(p.userId),
      p.scope.roleBindings.listForUser(p.userId),
      p.scope.projects.list(),
      p.scope.tenantRoles.holds(p.userId, 'tenant_admin'),
    ]);
    if (!user) throw new ApiError(401, 'unauthorized');
    const slugs = new Map(projects.map((project) => [project.id, project.slug]));
    return {
      user: { id: user.id, display_name: user.display_name, email: user.email },
      tenant_id: p.tenantId,
      token_id: p.tokenId,
      /** B13 (QUESTIONS #150): the caller may use the admin endpoints. */
      tenant_admin: tenantAdmin,
      roles: bindings.map((binding) => ({
        project: { id: binding.project_id, slug: slugs.get(binding.project_id) ?? null },
        role: binding.role,
      })),
    };
  }
}
