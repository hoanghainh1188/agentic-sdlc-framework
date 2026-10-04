// The task the agent gets (D-08 C05 AC2): the spec linked at G2 and the plan approved at G3, as
// the Run Contract binds them. The plan must be the contract's plan with the same hash and file
// list; the spec is the intent's latest one (a spec changed after G2 sends the intent back to G2
// before any run, FR-02 / B08). AGENTS.md is loaded by the agent from the workspace.
import type { AgentTask, RunContract } from '@sdlc/contracts';
import type { TenantScope } from '@sdlc/core';

import { AgentRunError } from './errors.js';
import { readRunFeedback, type FeedbackAccess } from './feedback.js';

/**
 * C08 PR 2 (QUESTIONS #158): the intent's last G6 decision is a `fail ci_failed`, so this run is a
 * retry after CI failed on the pushed commit.
 */
async function followsCiFailure(scope: TenantScope, intentId: string): Promise<boolean> {
  const last = (await scope.gateDecisions.listForIntent(intentId, 'G6')).at(-1);
  return last?.decision === 'fail' && last.reason_code === 'ci_failed';
}

export async function loadAgentTask(
  scope: TenantScope,
  contract: RunContract,
  feedback: FeedbackAccess = {},
): Promise<AgentTask> {
  // E01 PR 2: the feedback of a request for changes at G7, read before the agent starts. Throws
  // `feedback_unavailable` itself (fail closed).
  const reviewFeedback = await readRunFeedback(scope, contract, feedback);
  try {
    const plan = (await scope.plans.list(contract.intent_id)).find(
      (p) => p.id === contract.plan_id,
    );
    const spec = await scope.specRefs.latest(contract.intent_id);
    if (!plan || !spec || plan.plan_sha256 !== contract.plan_sha256) {
      throw new AgentRunError('task_unavailable');
    }
    const planned = plan.planned_files;
    if (
      planned.length !== contract.planned_files.length ||
      planned.some((file, i) => file !== contract.planned_files[i])
    ) {
      throw new AgentRunError('task_unavailable');
    }
    return {
      spec: {
        path: spec.path,
        commitSha: spec.commit_sha,
        contentSha256: spec.content_sha256,
      },
      plan: { summary: plan.summary, plannedFiles: [...planned] },
      ...((await followsCiFailure(scope, contract.intent_id)) ? { ciFailed: true } : {}),
      ...(reviewFeedback ? { reviewFeedback } : {}),
    };
  } catch (error) {
    if (error instanceof AgentRunError) throw error;
    throw new AgentRunError('task_unavailable');
  }
}
