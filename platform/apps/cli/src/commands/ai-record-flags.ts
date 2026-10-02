// The content flags of the project AI record, shared by `sdlc ai-record set` (API, task B04) and
// `sdlc admin ai-record set` (operator, task B12). Codes only (ADR-M32 §2.2).

export const AI_RECORD_CONTENT_OPTIONS = {
  'expected-version': { type: 'string' },
  'ai-allowed': { type: 'string' },
  classes: { type: 'string' },
  'prod-logs': { type: 'string' },
  disclosure: { type: 'string' },
  'confirmed-at': { type: 'string' },
  'record-ref': { type: 'string' },
} as const;

export const AI_RECORD_CONTENT_REQUIRED = [
  'expected-version',
  'ai-allowed',
  'classes',
  'prod-logs',
  'disclosure',
] as const;

export const EXPECTED_VERSION_PATTERN = /^\d{1,9}$/;

/** `none` or an empty value: no classes. Otherwise a comma-separated list. */
export function classList(value: string): string[] {
  if (value === 'none') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}
