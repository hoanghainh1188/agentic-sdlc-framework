// `GET /v1/me`: who the token belongs to (for `sdlc login`, task B04). Only the caller's own data.
import { Controller, Get } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { ApiError } from '../errors/api-error.js';

@Controller('v1/me')
export class MeController {
  @Get()
  async me(@CurrentPrincipal() p: Principal): Promise<Record<string, unknown>> {
    const [user, bindings, projects] = await Promise.all([
      p.scope.users.getById(p.userId),
      p.scope.roleBindings.listForUser(p.userId),
      p.scope.projects.list(),
    ]);
    if (!user) throw new ApiError(401, 'unauthorized');
    const slugs = new Map(projects.map((project) => [project.id, project.slug]));
    return {
      user: { id: user.id, display_name: user.display_name, email: user.email },
      tenant_id: p.tenantId,
      token_id: p.tokenId,
      roles: bindings.map((binding) => ({
        project: { id: binding.project_id, slug: slugs.get(binding.project_id) ?? null },
        role: binding.role,
      })),
    };
  }
}
