// The passkey step-up for gate decisions and escalations (task U07, ADR-M73 §2.4).
import { startAuthentication } from '@simplewebauthn/browser';

import { stepUpOptions } from '../api/writes.js';

export class PasskeyCancelled extends Error {
  override readonly name = 'PasskeyCancelled';
}

export async function confirmGateDecisionWithPasskey(
  intent: string,
  gate: string,
  expectedInputSha256: string | null | undefined,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly challenge_id: string; readonly response: unknown }> {
  const { challenge_id: challengeId, options } = await stepUpOptions({
    action: 'gate.decide',
    intent,
    gate,
    ...(expectedInputSha256 ? { expected_input_sha256: expectedInputSha256 } : {}),
    request: body,
  });
  try {
    const response = await startAuthentication({
      optionsJSON: options,
    });
    return { challenge_id: challengeId, response };
  } catch {
    throw new PasskeyCancelled('cancelled');
  }
}

export async function confirmEscalationWithPasskey(
  escalation: string,
  expectedInputSha256: string | null | undefined,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly challenge_id: string; readonly response: unknown }> {
  const { challenge_id: challengeId, options } = await stepUpOptions({
    action: 'escalation.decide',
    escalation,
    ...(expectedInputSha256 ? { expected_input_sha256: expectedInputSha256 } : {}),
    request: body,
  });
  try {
    const response = await startAuthentication({
      optionsJSON: options,
    });
    return { challenge_id: challengeId, response };
  } catch {
    throw new PasskeyCancelled('cancelled');
  }
}
