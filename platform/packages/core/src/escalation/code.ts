// Escalation codes `ESC-YYYY-NNNN`, unique within the tenant (template T16, D-05 section 6.4b).
// Same rules as intent codes (ADR-M20 D3): the UTC year of the clock, numbering starts again at
// 0001 each year, and the number grows past 9999.
import { intentCodeYear } from '../registry/intent-code.js';

export const ESCALATION_CODE_PATTERN = /^ESC-(\d{4})-(\d{4,9})$/;
const MAX_NUMBER = 999_999_999;

export function escalationCodeYear(at: Date): number {
  return intentCodeYear(at);
}

export function formatEscalationCode(year: number, number: number): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError(`escalation code year out of range: ${String(year)}`);
  }
  if (!Number.isInteger(number) || number < 1 || number > MAX_NUMBER) {
    throw new RangeError(`escalation code number out of range: ${String(number)}`);
  }
  return `ESC-${String(year)}-${String(number).padStart(4, '0')}`;
}

export function parseEscalationCode(code: string): { year: number; number: number } | undefined {
  const match = ESCALATION_CODE_PATTERN.exec(code);
  if (!match) return undefined;
  return { year: Number(match[1]), number: Number(match[2]) };
}
