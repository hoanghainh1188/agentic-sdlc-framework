// WebAuthn ceremonies for the dashboard's passkeys (task U06, design/ADR-M73 §2.4, QUESTIONS
// #413), with `@simplewebauthn/server` 14.0.3 (MIT, pinned exactly). Core stores and compares;
// this file builds the options and checks the browser's answers.
//
// - The site name (RP ID) is the host name of `SDLC_API_PUBLIC_ORIGIN` and the expected origin
//   is that origin: `localhost` on a developer machine, the V09 proxy's host name on a server.
//   WebAuthn refuses an IP address as a site name.
// - User verification is required (a PIN, a fingerprint), attestation `none` (no device data),
//   algorithms EdDSA, ES256, RS256 only (never the post-quantum default of the library: the
//   database accepts these three).
// - The challenge comes from core (32 random bytes); the answer is checked against its stored
//   SHA-256 only.
// - The library's error text never reaches the client or the log: every failure is
//   `PasskeyCheckError` with a code.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { cose, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import { hashPasskeyChallenge, type VerifiedCredential } from '@sdlc/core';

/** COSE algorithms the platform accepts: EdDSA, ES256, RS256 (migration 0028). */
export const PASSKEY_ALGORITHMS = [-8, -7, -257] as const;

/** How long the browser may take, in milliseconds: the challenge's lifetime (2 minutes). */
const TIMEOUT_MS = 120_000;

/** The site name people see in their passkey manager. */
const RP_NAME = 'Agentic SDLC';

const NIL_AAGUID = '00000000-0000-0000-0000-000000000000';

/** A passkey answer that does not hold. `code` is logged; the client sees `passkey_refused`. */
export class PasskeyCheckError extends Error {
  override readonly name = 'PasskeyCheckError';

  constructor(readonly code: 'not_verified' | 'malformed' | 'user_not_verified') {
    super(code);
  }
}

export interface PasskeyUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

/** A stored passkey, as the authentication check needs it. */
export interface StoredPasskey {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly signCount: number;
}

export class WebAuthnCeremonies {
  readonly rpId: string;
  readonly origin: string;

  constructor(publicOrigin: string) {
    const url = new URL(publicOrigin);
    this.origin = url.origin;
    this.rpId = url.hostname;
  }

  registrationOptions(input: {
    readonly challenge: string;
    readonly user: PasskeyUser;
    readonly exclude: readonly string[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: this.rpId,
      // Shown on the person's device only; never stored by the platform.
      userName: input.user.email,
      userDisplayName: input.user.displayName,
      userID: new Uint8Array(Buffer.from(input.user.id, 'utf8')),
      challenge: new Uint8Array(Buffer.from(input.challenge, 'base64url')),
      timeout: TIMEOUT_MS,
      attestationType: 'none',
      excludeCredentials: input.exclude.map((id) => ({ id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
    });
  }

  async verifyRegistration(
    response: RegistrationResponseJSON,
    challengeSha256: string,
  ): Promise<VerifiedCredential> {
    let result;
    try {
      result = await verifyRegistrationResponse({
        response,
        expectedChallenge: (challenge) => hashPasskeyChallenge(challenge) === challengeSha256,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
      });
    } catch {
      throw new PasskeyCheckError('malformed');
    }
    if (!result.verified) throw new PasskeyCheckError('not_verified');
    const info = result.registrationInfo;
    if (!info.userVerified) throw new PasskeyCheckError('user_not_verified');
    return {
      credentialId: info.credential.id,
      publicKey: info.credential.publicKey,
      algorithm: coseAlgorithm(info.credential.publicKey),
      signCount: info.credential.counter,
      aaguid: info.aaguid === NIL_AAGUID ? null : info.aaguid,
    };
  }

  authenticationOptions(input: {
    readonly challenge: string;
    readonly allow: readonly string[];
  }): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: input.allow.map((id) => ({ id })),
      challenge: new Uint8Array(Buffer.from(input.challenge, 'base64url')),
      timeout: TIMEOUT_MS,
      userVerification: 'required',
    });
  }

  /** Checks a step-up answer against one stored passkey. Returns the new counter. */
  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    challengeSha256: string,
    passkey: StoredPasskey,
  ): Promise<number> {
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (challenge) => hashPasskeyChallenge(challenge) === challengeSha256,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: passkey.signCount,
        },
        requireUserVerification: true,
      });
    } catch {
      throw new PasskeyCheckError('malformed');
    }
    if (!result.verified) throw new PasskeyCheckError('not_verified');
    if (!result.authenticationInfo.userVerified) throw new PasskeyCheckError('user_not_verified');
    return result.authenticationInfo.newCounter;
  }
}

/** The COSE algorithm of a COSE public key; the library already refused any other one. */
export function coseAlgorithm(key: Uint8Array): number {
  let alg: number | undefined;
  try {
    alg = decodeCredentialPublicKey(new Uint8Array(key)).get(cose.COSEKEYS.alg);
  } catch {
    throw new PasskeyCheckError('malformed');
  }
  if (alg === undefined || !(PASSKEY_ALGORITHMS as readonly number[]).includes(alg)) {
    throw new PasskeyCheckError('malformed');
  }
  return alg;
}
