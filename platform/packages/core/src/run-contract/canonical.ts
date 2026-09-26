// The signed form of a Run Contract (ADR-M22 section 2.2): the RFC 8785 canonical JSON of the
// contract without its signature, in UTF-8. Same canonicalisation module as the audit log and
// `config_hash` (ADR-M18).
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import type { RunContract } from '@sdlc/contracts';

/** The exact bytes that are signed and hashed. */
export function runContractBytes(contract: RunContract): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalJson(contract), 'utf8'));
}

/** `contract_sha256`: SHA-256 of the canonical bytes, lowercase hex. */
export function runContractSha256(contract: RunContract): string {
  return createHash('sha256').update(runContractBytes(contract)).digest('hex');
}
