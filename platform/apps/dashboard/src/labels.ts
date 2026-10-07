// Catalog keys for the platform's codes. Codes the handbook uses as they are (G1–G8, HITL, risk
// tiers, statuses) are shown as codes; roles and oversight modes get words.
import { cleanText } from '@sdlc/api-schemas';

import { t } from './i18n.js';

const ROLE_KEYS: Readonly<Record<string, string>> = {
  person_a: 'dashboard.role.person_a',
  person_b: 'dashboard.role.person_b',
  second_approver: 'dashboard.role.second_approver',
  pm_brse: 'dashboard.role.pm_brse',
  governance: 'dashboard.role.governance',
  admin: 'dashboard.role.admin',
  viewer: 'dashboard.role.viewer',
};

export function roleName(role: string | null): string {
  if (role === null) return '—';
  const key = ROLE_KEYS[role];
  return key ? t(key) : cleanText(role);
}

const MODE_KEYS: Readonly<Record<string, string>> = {
  HITL: 'dashboard.mode.hitl',
  HOTL: 'dashboard.mode.hotl',
  AUDIT: 'dashboard.mode.audit',
  POLICY: 'dashboard.mode.policy',
};

/** What a mode means for the person reading the board. */
export function modeMeaning(mode: string): string {
  const key = MODE_KEYS[mode];
  return key ? t(key) : cleanText(mode);
}
