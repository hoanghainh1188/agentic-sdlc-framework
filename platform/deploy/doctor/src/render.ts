// Prints the results of `pnpm doctor`: one line per check, the fix under each problem, a summary
// (D-08 V07 AC1). Every text comes from the catalog (`doctor.*`); `--json` gives the same.
import { cleanText } from '@sdlc/api-schemas';
import { t } from '@sdlc/messages';

import type { CheckResult, Text } from './types.js';

const STATUS_KEYS = {
  ok: 'doctor.status.ok',
  warning: 'doctor.status.warning',
  failed: 'doctor.status.failed',
  skipped: 'doctor.status.skipped',
} as const;

/** Control and bidirectional characters out of any value (paths, names) before printing. */
const clean = (value: string): string => cleanText(value);

export function render(item: Text): string {
  const params = Object.fromEntries(
    Object.entries(item.params ?? {}).map(([k, v]) => [k, typeof v === 'string' ? clean(v) : v]),
  );
  return t(item.key, params);
}

export function renderText(results: readonly CheckResult[], envFile: string): string[] {
  const lines = [t('doctor.header', { env: clean(envFile) })];
  for (const r of results) {
    const id = r.subject ? `${r.id} (${clean(r.subject)})` : r.id;
    lines.push(t('doctor.line', { status: t(STATUS_KEYS[r.status]), id, text: render(r.text) }));
    if (r.fix) lines.push(t('doctor.fix_line', { text: render(r.fix) }));
  }
  const count = (s: CheckResult['status']) => results.filter((r) => r.status === s).length;
  lines.push(
    t('doctor.summary', {
      ok: count('ok'),
      warning: count('warning'),
      failed: count('failed'),
      skipped: count('skipped'),
    }),
  );
  return lines;
}

export function renderJson(results: readonly CheckResult[], envFile: string): string {
  return JSON.stringify(
    {
      env_file: clean(envFile),
      checks: results.map((r) => ({
        id: r.id,
        ...(r.subject ? { subject: clean(r.subject) } : {}),
        status: r.status,
        message: render(r.text),
        ...(r.fix ? { fix: render(r.fix) } : {}),
      })),
    },
    null,
    2,
  );
}
