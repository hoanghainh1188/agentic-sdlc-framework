// What holds an intent (U02, ADR-M54 §2.4b): the workflow's recorded waiting reason and cause as
// catalog keys. `decision` is the normal wait for a person, shown by "Who decides this gate".
import {
  isHold,
  WAITING_CAUSE_KEYS,
  WAITING_REASON_KEYS,
  type IntentView,
} from '@sdlc/api-schemas';

export interface Hold {
  /** A catalog key, or the code itself when the dashboard has no label for it yet. */
  readonly reason: { readonly key: string } | { readonly code: string };
  readonly cause: { readonly key: string } | { readonly code: string } | null;
  readonly since: string | null;
  readonly until: string | null;
}

function label(keys: Readonly<Record<string, string>>, code: string) {
  const key = keys[code];
  return key ? { key } : { code };
}

export function holdOf(
  intent: Pick<IntentView, 'waiting_reason' | 'waiting_cause' | 'waiting_since' | 'waiting_until'>,
): Hold | null {
  if (!isHold(intent.waiting_reason)) return null;
  return {
    reason: label(WAITING_REASON_KEYS, intent.waiting_reason),
    cause: intent.waiting_cause ? label(WAITING_CAUSE_KEYS, intent.waiting_cause) : null,
    since: intent.waiting_since ?? null,
    until: intent.waiting_until ?? null,
  };
}
