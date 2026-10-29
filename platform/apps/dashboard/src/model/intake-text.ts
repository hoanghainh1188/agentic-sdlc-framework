// The catalog text of a refused or failed U08 action (`intake.ts` picks the key).
import { ApiError } from '../api/client.js';
import { t } from '../i18n.js';
import { actionErrorText } from './decisions.js';
import { intakeErrorKey, type IntakeAction } from './intake.js';

/** The catalog text of a refused or failed U08 action. */
export function intakeErrorText(error: unknown, action: IntakeAction): string {
  const found = error instanceof ApiError ? intakeErrorKey(error, action) : null;
  if (found === null) return actionErrorText(error);
  const params: Record<string, string> = { ...found.params };
  if (found.refusalKey !== undefined) params.refusal = t(found.refusalKey);
  return t(found.key, params);
}
