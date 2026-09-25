// Structured logging hook (task A08 connects the platform logger). Fields are typed as
// primitives and filled only with safe values: TTLs, HTTP status codes, paths, key versions.
// No free text from OpenBao and no secret ever goes into a field.

export type SecretsLogEvent =
  | 'openbao.plaintext'
  | 'openbao.login'
  | 'openbao.token_renewed'
  | 'openbao.renew_failed'
  | 'openbao.token_expired'
  | 'openbao.revoke_failed';

export type SecretsLogFields = Readonly<Record<string, string | number | boolean>>;

export interface SecretsLogger {
  log(level: 'info' | 'warn' | 'error', event: SecretsLogEvent, fields: SecretsLogFields): void;
}

export const silentLogger: SecretsLogger = { log: () => undefined };
