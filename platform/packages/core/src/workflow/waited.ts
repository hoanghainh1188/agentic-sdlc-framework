// Waiting time of a gate (D-02 FR-12, task B07 session 2).
import type { Intent } from '../db/schema.js';

/** Seconds the intent has waited at its gate (FR-12): from the entry, wall-clock time. */
export function waitedSeconds(intent: Pick<Intent, 'gate_entered_at'>, at: Date): number | null {
  if (intent.gate_entered_at === null) return null;
  return Math.max(
    0,
    Math.floor((at.getTime() - new Date(intent.gate_entered_at).getTime()) / 1000),
  );
}
