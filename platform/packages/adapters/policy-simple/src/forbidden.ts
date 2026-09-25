// Forbidden agent actions (handbook Ch.4 §4.7, codes table §2.1). The lists live in
// `@sdlc/contracts`; no project configuration can change them.
import type { AgentAction } from '@sdlc/contracts';
import { FORBIDDEN_AGENT_ACTIONS, GRANT_REQUIRED_AGENT_ACTIONS } from '@sdlc/contracts';

const isListed = (list: readonly string[], kind: string): boolean => list.includes(kind);

/** A HITL grant for exactly this scope, not expired. */
function hasValidGrant(action: AgentAction, now: Date): boolean {
  const { grant, scope } = action;
  return (
    grant !== undefined &&
    grant.mode === 'HITL' &&
    scope !== undefined &&
    grant.scope === scope &&
    now.getTime() < grant.expiresAt.getTime()
  );
}

export function isForbidden(input: { action: AgentAction; now?: Date }): boolean {
  const { action } = input;
  if (isListed(FORBIDDEN_AGENT_ACTIONS, action.kind)) return true;
  if (isListed(GRANT_REQUIRED_AGENT_ACTIONS, action.kind)) {
    return !hasValidGrant(action, input.now ?? new Date());
  }
  return false;
}
