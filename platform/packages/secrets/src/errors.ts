// Errors of the OpenBao client. The message comes from the message catalog (NFR-08, ADR-M18).
// Params hold only safe values: addresses, file paths, secret paths, HTTP status codes and Node
// error codes. Never a token, role ID, secret ID, secret value, request body or raw OpenBao error
// text (it can echo input). No `cause` is attached, so a stack trace holds nothing more.
import { t, type MessageKey, type MessageParams } from '@sdlc/messages';

export type SecretsErrorKey = Extract<MessageKey, `secrets.${string}`>;

export class SecretsError extends Error {
  override readonly name = 'SecretsError';

  constructor(
    readonly key: SecretsErrorKey,
    readonly params: MessageParams = {},
  ) {
    super(t(key, params));
  }
}
