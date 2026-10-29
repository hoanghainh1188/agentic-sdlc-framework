// Every write the dashboard sends (U05, U06, design/ADR-M73 §2.3, §2.4), with a fixed path:
// sign out, the person's own passkeys, the passkey step-up, and the four evaluation plan actions
// of L05 (ADR-M82 §2.7, QUESTIONS #470). Nothing here changes an intent, gate, run or escalation;
// those come with U07. A static test checks that these are the only writes and that each is a
// route of the API.
import {
  decisionSchema,
  endedSessionsSchema,
  escalationSchema,
  evalPlanSchema,
  intentSchema,
  killResultSchema,
  stepUpOptionsSchema,
  passkeyRegistrationOptionsSchema,
  passkeySchema,
  type DecisionView,
  type EscalationView,
  type EvalPlanView,
  type IntentView,
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

export type StepUpRequestInput =
  | { readonly action: EvalPlanAction; readonly request: Readonly<Record<string, unknown>> }
  | {
      readonly action: 'gate.decide';
      readonly intent: string;
      readonly gate: string;
      readonly expected_input_sha256?: string;
      readonly request: Readonly<Record<string, unknown>>;
    }
  | {
      readonly action: 'escalation.decide';
      readonly escalation: string;
      readonly expected_input_sha256?: string;
      readonly request: Readonly<Record<string, unknown>>;
    };

/**
 * A passkey challenge for one action, bound to the body the page will send (without
 * `step_up`).
 */
export async function stepUpOptions(
  actionOrPayload: EvalPlanAction | StepUpRequestInput,
  request?: Readonly<Record<string, unknown>>,
): Promise<StepUpOptions> {
  const payload =
    typeof actionOrPayload === 'string'
      ? { action: actionOrPayload, request: request! }
      : actionOrPayload;
  const answer = await send(apiPath('/v1/auth/step-up'), 'POST', stepUpOptionsSchema, payload);
  return answer!;
}

/** U07: Kills an active run (ADR-M42). No step-up: containment must be fast. */
export async function killRun(runId: string): Promise<void> {
  await send(apiPath(`/v1/runs/${segment(runId)}/kill`), 'POST', killResultSchema, {});
}

/** U07: Decides a gate (ADR-M73). */
export async function decideGate(
  intent: string,
  gate: string,
  body: unknown,
): Promise<DecisionView> {
  const answer = await send(
    apiPath(`/v1/intents/${segment(intent)}/gates/${segment(gate)}/decisions`),
    'POST',
    decisionSchema,
    body,
  );
  return answer!;
}

/** U07: Acknowledges an escalation (ADR-M28). */
export async function ackEscalation(code: string): Promise<EscalationView> {
  const answer = await send(
    apiPath(`/v1/escalations/${segment(code)}/ack`),
    'POST',
    escalationSchema,
    {},
  );
  return answer!;
}

/** U07: Decides an escalation (ADR-M28). */
export async function decideEscalation(code: string, body: unknown): Promise<EscalationView> {
  const answer = await send(
    apiPath(`/v1/escalations/${segment(code)}/decisions`),
    'POST',
    escalationSchema,
    body,
  );
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

export interface CreateIntentInput {
  readonly project: string;
  readonly title: string;
  readonly description?: string;
  readonly risk_tier: 'low' | 'medium' | 'high' | 'critical';
  readonly data_class: 'public' | 'internal' | 'confidential' | 'restricted';
  readonly budget_usd?: string;
  readonly issue_number?: number;
}

/** U08: Creates a new intent directly from the dashboard. */
export async function createIntent(body: CreateIntentInput): Promise<IntentView> {
  const answer = await send(apiPath('/v1/intents'), 'POST', intentSchema, { body });
  return answer!;
}
