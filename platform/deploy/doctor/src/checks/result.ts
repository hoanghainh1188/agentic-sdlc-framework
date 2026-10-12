// Small builders for check results (D-08 V07): every result has a catalog text, and every warning
// or failure has its fix.
import type { MessageKey, MessageParams } from '@sdlc/messages';

import type { CheckId, CheckResult, Text } from '../types.js';

export const text = (key: MessageKey, params?: MessageParams): Text => ({
  key,
  ...(params ? { params } : {}),
});

export function ok(id: CheckId, t: Text, subject?: string): CheckResult {
  return { id, status: 'ok', text: t, ...(subject ? { subject } : {}) };
}

export function problem(
  id: CheckId,
  status: 'warning' | 'failed',
  t: Text,
  fix: Text,
  subject?: string,
): CheckResult {
  return { id, status, text: t, fix, ...(subject ? { subject } : {}) };
}

export function skipped(id: CheckId, reason: MessageKey, subject?: string): CheckResult {
  return { id, status: 'skipped', text: { key: reason }, ...(subject ? { subject } : {}) };
}

export const GIB = 1024 ** 3;
