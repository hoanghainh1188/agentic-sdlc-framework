// Every write the dashboard sends (U05, U06, design/ADR-M73 §2.3, §2.4), with a fixed path:
// sign out, and the person's own passkeys. Nothing here changes an intent, gate, run or
// escalation; those come with U07. A static test checks that these are the only writes and that
// each is a route of the API.
import {
  endedSessionsSchema,
  passkeyRegistrationOptionsSchema,
  passkeySchema,
  type PasskeyRegistrationOptions,
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
