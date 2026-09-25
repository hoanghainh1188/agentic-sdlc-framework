// Intent codes `INT-YYYY-NNNN`, unique within the tenant (D-02 FR-01, ADR-M20).
// The year is the UTC year of the registry clock (D-05 D5). Numbering starts again at 0001 each
// year; after 9999 the number simply grows (`INT-2026-10000`).

export const INTENT_CODE_PATTERN = /^INT-(\d{4})-(\d{4,9})$/;
const MAX_NUMBER = 999_999_999;

export function intentCodeYear(at: Date): number {
  const year = at.getUTCFullYear();
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError(`intent code year out of range: ${String(year)}`);
  }
  return year;
}

export function formatIntentCode(year: number, number: number): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError(`intent code year out of range: ${String(year)}`);
  }
  if (!Number.isInteger(number) || number < 1 || number > MAX_NUMBER) {
    throw new RangeError(`intent code number out of range: ${String(number)}`);
  }
  return `INT-${String(year)}-${String(number).padStart(4, '0')}`;
}

export function parseIntentCode(code: string): { year: number; number: number } | undefined {
  const match = INTENT_CODE_PATTERN.exec(code);
  if (!match) return undefined;
  return { year: Number(match[1]), number: Number(match[2]) };
}
