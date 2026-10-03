// Runs of an intent and the kill switch (task C11, D-08 C11 AC1, D-02 FR-34, ADR-M42 §2.6).
// Reading follows `access.intent_read_roles`; killing needs a role in `access.kill_roles`: no
// role on the project → 404, another role → 403. After a kill the intent's workflow gets the
// `kill` signal (it cancels the run's activity) and a wake; a failed signal never fails the
// request: the runner sees the kill in the database, and the reconcile loop signals again.
import {
  CommandError,
  INTENT_CODE_PATTERN,
  planAccess,
  requestRunKill,
  withLogContext,
  type Intent,
  type Registry,
  type TenantScope,
} from '@sdlc/core';
import type { IntentWorkflowRef, IntentWorkflowSignals } from '@sdlc/contracts';

import type { Principal } from '../auth/principal.js';
import { wakeQuietly, type WakeLogger } from '../intent-signals.js';
import { presentKill, presentRunList } from './present.js';

export class RunsService {
  constructor(
    private readonly registry: Registry,
    private readonly signals: IntentWorkflowSignals,
    private readonly logger: WakeLogger,
  ) {}

  async kill(p: Principal, runId: string): Promise<Record<string, unknown>> {
    const result = await requestRunKill(
      p.scope,
      { now: () => this.registry.now() },
      { runId, actor: { type: 'human', id: p.userId }, source: 'api' },
    );
    const intent = await p.scope.intents.getById(result.intentId);
    if (!result.already) {
      const ref = { tenantId: p.scope.tenantId, intentId: result.intentId };
      await killQuietly(this.signals, ref, this.logger);
      await wakeQuietly(this.signals, ref, this.logger);
    }
    return presentKill(intent?.code ?? '-', result);
  }

  async list(p: Principal, ref: string): Promise<Record<string, unknown>> {
    const intent = await this.intent(p.scope, ref);
    // Who may read an intent's runs: as for its plans (`access.intent_read_roles`).
    const access = await planAccess(p.scope, intent.project_id, p.userId);
    if (!access.canRead) throw new CommandError('intent_not_found', `intent ${ref} not found`);
    return presentRunList(intent.code, await p.scope.runs.listForIntent(intent.id));
  }

  private async intent(scope: TenantScope, ref: string): Promise<Intent> {
    const intent = INTENT_CODE_PATTERN.test(ref)
      ? await scope.intents.getByCode(ref)
      : await scope.intents.getById(ref);
    if (!intent) throw new CommandError('intent_not_found', `intent ${ref} not found`);
    return intent;
  }
}

/** The kill signal; a failure is only logged (IDs from the log context). */
async function killQuietly(
  signals: IntentWorkflowSignals,
  ref: IntentWorkflowRef,
  logger: WakeLogger,
): Promise<void> {
  try {
    await signals.kill(ref);
  } catch {
    withLogContext({ tenantId: ref.tenantId, intentId: ref.intentId }, () =>
      logger.log('warn', 'api.intent_kill_signal_failed', {}),
    );
  }
}
