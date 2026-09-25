// Who may approve a gate (design/D-03 section 6.2, D-02 FR-11 and FR-16).
// The roles and the number of approvals come from the resolved oversight (configuration). The
// separation-of-duties rules below are never configurable (handbook Ch.4 §4.7, codes table §5):
//   - agents and the system never approve;
//   - a producer of the change never approves it;
//   - revoked role bindings do not count;
//   - two approvals always come from two different people.
import type {
  ApproveDecision,
  ApproverInput,
  PriorApproval,
  ProjectRole,
  ValidatedProjectConfig,
} from '@sdlc/contracts';

import { resolveOversight } from './oversight.js';

const refuse = (
  reason: Extract<ApproveDecision, { allowed: false }>['reason'],
): ApproveDecision => ({
  allowed: false,
  reason,
});

/** Prior approvals that count: not from a producer, one per person, one per role. */
function countedApprovals(
  prior: readonly PriorApproval[],
  producers: readonly string[],
  roles: readonly ProjectRole[],
): PriorApproval[] {
  const counted: PriorApproval[] = [];
  for (const approval of prior) {
    const valid =
      !producers.includes(approval.userId) &&
      roles.includes(approval.role) &&
      !counted.some((c) => c.userId === approval.userId);
    if (valid) counted.push(approval);
  }
  return counted;
}

export function canApprove(config: ValidatedProjectConfig, input: ApproverInput): ApproveDecision {
  if (input.actor.type !== 'human') return refuse('actor_not_human');
  if (input.producers.includes(input.actor.id)) return refuse('producer');

  const oversight = resolveOversight(config, {
    gate: input.gate,
    riskTier: input.intent.riskTier,
    changeFlags: input.intent.changeFlags,
    ...(input.context === undefined ? {} : { context: input.context }),
  });
  // POLICY: an automatic check. AUDIT: sampled after the fact. Neither has an approval step.
  if (oversight.mode === 'POLICY' || oversight.mode === 'AUDIT') return refuse('no_human_decision');

  const held = input.roles
    .filter((binding) => binding.revokedAt === null)
    .map((binding) => binding.role);
  const eligible = oversight.roles.filter((role) => held.includes(role));
  if (eligible.length === 0) return refuse('role_missing');

  // Any earlier approval by the same person counts here, even under a role the gate no longer lists.
  if ((input.priorApprovals ?? []).some((approval) => approval.userId === input.actor.id)) {
    return refuse('already_approved');
  }
  const prior = countedApprovals(input.priorApprovals ?? [], input.producers, oversight.roles);
  const needed = Math.max(oversight.approvalsNeeded, 1);
  if (prior.length >= needed) return refuse('approvals_complete');

  // One approval per role when the gate needs as many approvals as it lists roles (dual approval).
  const onePerRole = oversight.roles.length > 1 && needed >= oversight.roles.length;
  const open = onePerRole
    ? eligible.filter((role) => !prior.some((approval) => approval.role === role))
    : eligible;
  const role = open[0];
  return role === undefined ? refuse('role_already_covered') : { allowed: true, role };
}
