// OpenBao client for the platform processes (D-03 sections 8 and 8.2, D-08 A04, ADR-M21).
// The interfaces other packages depend on are in @sdlc/contracts (SecretReader,
// RunContractSigner, RunContractVerifier, RedactedSecret).
export { OpenBaoClient, type SealStatus } from './client.js';
export { parseSignature, verifyEd25519, type ParsedSignature } from './ed25519.js';
export { SecretsError, type SecretsErrorKey } from './errors.js';
export { checkSecretPath } from './kv.js';
export type { SecretsLogEvent, SecretsLogFields, SecretsLogger } from './logger.js';
export {
  DEFAULT_MOUNTS,
  DEFAULT_TIMEOUT_MS,
  ENV,
  optionsFromEnv,
  RUN_CONTRACT_KEY,
  type OpenBaoClientOptions,
} from './options.js';
export { REDACTED, Redacted } from './redacted.js';
export { TransitKey } from './transit.js';
