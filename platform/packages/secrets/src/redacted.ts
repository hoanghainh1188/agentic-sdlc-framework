// A secret value that does not appear in logs, errors or serialised objects (D-08 A04 AC3).
import { inspect } from 'node:util';

import type { RedactedSecret } from '@sdlc/contracts';

export const REDACTED = '[redacted]';

export class Redacted implements RedactedSecret {
  // A private field: not enumerable, not copied by spread, not visible to JSON or inspect.
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only way to read the value. Use it where the value is needed; never log it. */
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
