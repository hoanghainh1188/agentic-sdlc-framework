// The passkey step-up of an evaluation plan action (task L05, design/ADR-M82 §2.7; U06, ADR-M73
// §2.4): a challenge bound to the body the page will send, the browser's WebAuthn ceremony, and
// the answer to put in the body as `step_up`. The API checks it again and uses it once.
import { startAuthentication } from '@simplewebauthn/browser';

import { stepUpOptions, type EvalPlanAction } from '../api/writes.js';
import { stepUpRequest } from '../model/evaluations.js';

/** Thrown when the person cancelled the browser's passkey prompt (no API refusal). */
export class PasskeyCancelled extends Error {
  override readonly name = 'PasskeyCancelled';
}

export async function confirmWithPasskey(
  action: EvalPlanAction,
  body: Readonly<Record<string, unknown>>,
  target: string,
): Promise<{ readonly challenge_id: string; readonly response: unknown }> {
  const decision =
    action === 'eval_plan.create' ? 'create' : action === 'eval_plan.change' ? 'change' : 'run';
  const { challenge_id: challengeId, options } = await stepUpOptions(
    action,
    stepUpRequest(body, decision, target),
  );
  try {
    const response = await startAuthentication({
      optionsJSON: options,
    });
    return { challenge_id: challengeId, response };
  } catch {
    throw new PasskeyCancelled('cancelled');
  }
}
