// Waking the intent workflow after a change (task B07, design/ADR-M30 §2.3). The api records a
// change in the database first; the workflow reads it when it wakes. A failed signal never fails the
// request: the worker's reconcile loop wakes every open intent later.
import type { IntentWorkflowRef, IntentWorkflowSignals } from '@sdlc/contracts';
import { withLogContext, type PlatformLogger } from '@sdlc/core';

export type WakeLogger = Pick<PlatformLogger, 'log'>;

export async function wakeQuietly(
  signals: IntentWorkflowSignals,
  ref: IntentWorkflowRef,
  logger: WakeLogger,
): Promise<void> {
  try {
    await signals.wake(ref);
  } catch {
    // IDs only (from the log context): the reason may hold library text.
    withLogContext({ tenantId: ref.tenantId, intentId: ref.intentId }, () =>
      logger.log('warn', 'api.intent_wake_failed', {}),
    );
  }
}
