// A token that never shows up in logs, errors or serialised objects (same rule as `Redacted` in
// @sdlc/secrets, which adapters may not import: ADR-M16 §2.5).
import { inspect } from 'node:util';

import type { RedactedSecret } from '@sdlc/contracts';

const REDACTED = '[redacted]';

export class SecretString implements RedactedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
