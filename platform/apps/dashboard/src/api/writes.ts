// Every write the dashboard sends (U05, U06, design/ADR-M73 §2.3, §2.4), with a fixed path:
// sign out, the person's own passkeys, the passkey step-up, and the four evaluation plan actions
// of L05 (ADR-M82 §2.7, QUESTIONS #470). Nothing here changes an intent, gate, run or escalation;
// those come with U07. A static test checks that these are the only writes and that each is a
// route of the API.
import {
  endedSessionsSchema,
  evalPlanSchema,
  stepUpOptionsSchema,
  passkeyRegistrationOptionsSchema,
  passkeySchema,
  type EvalPlanView,
  type PasskeyRegistrationOptions,
  type StepUpOptions,
  type PasskeyView,
} from '@sdlc/api-schemas';

import { apiPath, segment, send } from './client.js';

/** Ends the GitHub session of this browser (`this`) or every one of the person (`everywhere`). */
export async function endSession(scope: 'this' | 'everywhere'): Promise<void> {
  if (scope === 'this') await send(apiPath('/v1/auth/sign-out'), 'POST', null);
  else await send(apiPath('/v1/me/sessions'), 'DELETE', endedSessionsSchema);
}

/** A registration challenge; only within 5 minutes of the GitHub sign-in. */
export async function passkeyRegistrationOptions(): Promise<PasskeyRegistrationOptions> {
  const answer = await send(
    apiPath('/v1/me/passkeys/registration-options'),
    'POST',
    passkeyRegistrationOptionsSchema,
  );
  return answer!;
}

/** Stores the passkey the browser made for the challenge. */
export async function registerPasskey(
  challengeId: string,
  response: unknown,
): Promise<PasskeyView> {
  const answer = await send(apiPath('/v1/me/passkeys'), 'POST', passkeySchema, {
    challenge_id: challengeId,
    response,
  });
  return answer!;
}

/** Removes one of the person's own passkeys. */
export async function removePasskey(id: string): Promise<PasskeyView> {
  const answer = await send(apiPath(`/v1/me/passkeys/${segment(id)}`), 'DELETE', passkeySchema);
  return answer!;
}

/** The step-up actions of evaluation plans (L05). */
export type EvalPlanAction = 'eval_plan.create' | 'eval_plan.change' | 'eval_plan.run';

/**
 * A passkey challenge for one plan action, bound to the body the page will send (without
 * `step_up`) with `decision` and `target` (the project's slug for create, else the plan's ID).
 */
export async function stepUpOptions(
  action: EvalPlanAction,
  request: Readonly<Record<string, unknown>>,
): Promise<StepUpOptions> {
  const answer = await send(apiPath('/v1/auth/step-up'), 'POST', stepUpOptionsSchema, {
    action,
    request,
  });
  return answer!;
}

/** Creates a plan (L05); `step_up` when it runs on a schedule or on a change. */
export async function createEvalPlan(project: string, body: unknown): Promise<EvalPlanView> {
  const answer = await send(
    apiPath(`/v1/projects/${segment(project)}/eval-plans`),
    'POST',
    evalPlanSchema,
    body,
  );
  return answer!;
}

/** Writes the next version of a plan (L05). */
export async function changeEvalPlan(id: string, body: unknown): Promise<EvalPlanView> {
  const answer = await send(
    apiPath(`/v1/eval-plans/${segment(id)}/versions`),
    'POST',
    evalPlanSchema,
    body,
  );
  return answer!;
}

/** Archives a plan (L05): final. */
export async function archiveEvalPlan(id: string): Promise<EvalPlanView> {
  const answer = await send(
    apiPath(`/v1/eval-plans/${segment(id)}/archive`),
    'POST',
    evalPlanSchema,
    {},
  );
  return answer!;
}

/** Run now (L05): always with the passkey answer; the worker starts the evaluation. */
export async function runEvalPlan(id: string, body: unknown): Promise<EvalPlanView> {
  const answer = await send(
    apiPath(`/v1/eval-plans/${segment(id)}/runs`),
    'POST',
    evalPlanSchema,
    body,
  );
  return answer!;
}
