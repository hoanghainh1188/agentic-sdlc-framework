// USD amounts as decimal strings (D-05 D6: no floating point). Arithmetic runs on integer
// micro-dollars (6 decimals, the scale of numeric(18,6)).

const USD = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
// PostgreSQL returns numeric with its own scale ("0.001200"), and sums may be negative never; accept
// up to 6 decimals and trailing zeros.
const NUMERIC = /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/;
const SCALE = 1_000_000n;

/** True for a decimal string with at most 6 decimals, for example `"2"` or `"0.0012"`. */
export function isUsd(value: unknown): value is string {
  return typeof value === 'string' && USD.test(value);
}

/** Parses a decimal string (as written by us or returned by PostgreSQL) into micro-dollars. */
export function toMicros(value: string): bigint {
  if (!NUMERIC.test(value)) throw new RangeError('not a USD amount with at most 6 decimals');
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const micros = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  return negative ? -micros : micros;
}

/** Formats micro-dollars as the shortest decimal string (`1200n` → `"0.0012"`). */
export function fromMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Start of the UTC calendar month of `at` (the tenant budget period, ADR-M24 §2.3). */
export function startOfUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}
