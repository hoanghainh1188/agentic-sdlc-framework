// Errors of the runner. The message comes from the message catalog (NFR-08, ADR-M18). Params hold
// safe values only: setting names, Docker object names, HTTP status codes and Node error codes.
// Never a token, a session key, an environment value or raw Docker error text (it can echo input).
import { t, type MessageKey, type MessageParams } from '@sdlc/messages';

export type RunnerErrorKey = Extract<MessageKey, `runner.${string}`>;

export class RunnerError extends Error {
  override readonly name = 'RunnerError';

  constructor(
    readonly key: RunnerErrorKey,
    readonly params: MessageParams = {},
  ) {
    super(t(key, params));
  }
}
