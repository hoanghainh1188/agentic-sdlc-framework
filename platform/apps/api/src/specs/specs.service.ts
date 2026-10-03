// Specs of an intent (task B08, D-08 B08 AC1, ADR-M39 §2.2). Linking reads the file from the Git
// host and stores its SHA-256 only; reading lists the linked versions. Access follows the project
// configuration: no role → 404, a read role only → 403 on link (`access.spec_link_roles`).
// After a link the intent's workflow is woken: a spec linked at G3 or G4 takes it back to G2.
import {
  CommandError,
  INTENT_CODE_PATTERN,
  linkSpecFromGitHost,
  specAccess,
  SpecError,
  type Intent,
  type SpecGitHost,
  type TenantScope,
} from '@sdlc/core';
import type { IntentWorkflowSignals } from '@sdlc/contracts';
import type { z } from 'zod';

import type { Principal } from '../auth/principal.js';
import { wakeQuietly, type WakeLogger } from '../intent-signals.js';
import { presentLinkedSpec, presentSpecList } from './present.js';
import type { linkSpecSchema } from './schemas.js';

export class SpecsService {
  constructor(
    /** Undefined in dev mode without OpenBao: linking answers `git_host_unavailable`. */
    private readonly git: SpecGitHost | undefined,
    private readonly signals: IntentWorkflowSignals,
    private readonly logger: WakeLogger,
  ) {}

  async link(
    p: Principal,
    ref: string,
    body: z.infer<typeof linkSpecSchema>,
  ): Promise<Record<string, unknown>> {
    const intent = await this.intent(p.scope, ref);
    if (!this.git) {
      // Check access first, so the answer is the same as with a Git host.
      const access = await specAccess(p.scope, intent.project_id, p.userId);
      if (!access.canRead) throw new CommandError('intent_not_found', `intent ${ref} not found`);
      if (!access.canLink) throw new CommandError('forbidden', 'the caller may not link a spec');
      throw new SpecError('git_host_unavailable', 'no Git host in this process');
    }
    const spec = await linkSpecFromGitHost(p.scope, this.git, {
      intent,
      path: body.path,
      commitSha: body.commit_sha ?? null,
      sourceTool: body.source_tool ?? null,
      actorId: p.userId,
    });
    await wakeQuietly(
      this.signals,
      { tenantId: p.scope.tenantId, intentId: intent.id },
      this.logger,
    );
    return presentLinkedSpec(intent.code, spec);
  }

  async list(p: Principal, ref: string): Promise<Record<string, unknown>> {
    const intent = await this.intent(p.scope, ref);
    const access = await specAccess(p.scope, intent.project_id, p.userId);
    if (!access.canRead) throw new CommandError('intent_not_found', `intent ${ref} not found`);
    const specs = await p.scope.specRefs.list(intent.id);
    return presentSpecList(intent.code, specs);
  }

  private async intent(scope: TenantScope, ref: string): Promise<Intent> {
    const intent = INTENT_CODE_PATTERN.test(ref)
      ? await scope.intents.getByCode(ref)
      : await scope.intents.getById(ref);
    if (!intent) throw new CommandError('intent_not_found', `intent ${ref} not found`);
    return intent;
  }
}
