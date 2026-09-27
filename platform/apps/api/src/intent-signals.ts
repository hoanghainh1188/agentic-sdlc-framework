// Waking the intent workflow after a change (task B07, design/ADR-M30 §2.3). The api records a
// change in the database first; the workflow reads it when it wakes. A failed signal never fails the
// request: the worker's reconcile loop wakes every open intent later.
import type { IntentWorkflowRef, IntentWorkflowSignals } from '@sdlc/contracts';

export interface WakeLogger {
  warn(message: string): void;
}

export async function wakeQuietly(
  signals: IntentWorkflowSignals,
  ref: IntentWorkflowRef,
  logger: WakeLogger,
): Promise<void> {
  try {
    await signals.wake(ref);
  } catch {
    // IDs only: the reason may hold library text.
    logger.warn(`intent workflow wake failed: tenant ${ref.tenantId} intent ${ref.intentId}`);
  }
}
