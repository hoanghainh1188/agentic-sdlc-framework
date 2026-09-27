// B03 AC4: every error the API returns has a catalog message; library and database text never
// reaches the client.
import { catalogFor, placeholdersOf, t, type MessageKey } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import {
  API_ERROR_CODES,
  ApiError,
  errorMessageKey,
  toApiError,
} from '../../apps/api/src/errors/api-error.js';
import { reasonMessage } from '../../apps/api/src/errors/error.filter.js';
import { localeOf } from '../../apps/api/src/errors/locale.js';
import { CommandError } from '../../packages/core/src/commands/errors.js';
import { DbError, TenantGuardError } from '../../packages/core/src/db/errors.js';
import { RegistryError } from '../../packages/core/src/registry/errors.js';

const en = catalogFor('en')!;

// The API's refusal texts before B06 moved them from `api.reason.*` to the shared `gate.reason.*`
// keys (ADR-M27): the API must still return exactly these sentences.
const TEXTS_BEFORE_B06: Readonly<Record<string, string>> = {
  actor_not_human: 'Only people approve gates; agents and the platform never do.',
  producer: 'You produced this change, so you cannot approve it (separation of duties).',
  no_human_decision:
    'This gate is checked automatically or sampled afterwards: nobody approves it.',
  role_missing: 'You do not hold a role that may decide this gate.',
  already_approved: 'You already approved this: dual approval needs two different people.',
  role_already_covered: 'Your roles are already covered by another approver.',
  approvals_complete: 'The gate already has all the approvals it needs.',
  agent_never_decides: 'Agents never decide or approve gates.',
  decision_not_for_actor: 'People cannot send this kind of decision.',
  reason_required: 'A reason code is needed for this decision.',
  hitl_needs_a_person: "This gate needs a person's decision.",
  breach_never_passes: 'A scope or budget breach never passes.',
};

// Every ApprovalRefusal (contracts) and DecisionViolation (core) code.
const REASONS = [
  'actor_not_human',
  'producer',
  'no_human_decision',
  'role_missing',
  'already_approved',
  'role_already_covered',
  'approvals_complete',
  'agent_never_decides',
  'decision_not_for_actor',
  'reason_required',
  'hitl_needs_a_person',
  'breach_never_passes',
];

describe('api error catalog', () => {
  it('has a message without placeholders for every error code', () => {
    for (const code of API_ERROR_CODES) {
      const template = en[errorMessageKey(code)];
      expect(template, code).toBeDefined();
      expect(placeholdersOf(template!), code).toEqual([]);
    }
  });

  it('has a message for every refusal reason', () => {
    for (const reason of REASONS) {
      expect(en[`gate.reason.${reason}` as MessageKey], reason).toBeDefined();
      expect(reasonMessage(reason, 'en')).toBe(t(`gate.reason.${reason}` as MessageKey));
    }
    expect(reasonMessage('something_new', 'en')).toBe('something_new');
  });

  it('returns the same refusal texts as before the move to gate.reason.* (B06)', () => {
    expect(Object.keys(TEXTS_BEFORE_B06).sort()).toEqual([...REASONS].sort());
    for (const [reason, text] of Object.entries(TEXTS_BEFORE_B06)) {
      expect(reasonMessage(reason, 'en'), reason).toBe(text);
    }
    expect(Object.keys(en).filter((key) => key.startsWith('api.reason.'))).toEqual([]);
  });

  it.each([
    [new CommandError('gate_not_supported', 'x'), 422, 'gate_not_supported'],
    [new CommandError('gate_input_missing', 'x'), 409, 'gate_input_missing'],
    [new CommandError('project_not_found', 'x'), 404, 'project_not_found'],
    [new CommandError('forbidden', 'x'), 403, 'forbidden'],
    [new RegistryError('intent_not_found', 'x'), 404, 'intent_not_found'],
    [new RegistryError('approval_refused', 'x', 'producer'), 403, 'approval_refused'],
    [
      new RegistryError('decision_not_allowed', 'x', 'reason_required'),
      422,
      'decision_not_allowed',
    ],
    [new RegistryError('decision_not_allowed', 'x', 'role_missing'), 403, 'decision_not_allowed'],
    [new RegistryError('config_hash_mismatch', 'x'), 409, 'config_invalid'],
    [new DbError('invalid_value', 'column foo'), 400, 'invalid_request'],
    [new DbError('conflict', 'x'), 409, 'conflict'],
    [new DbError('permission_denied', 'x'), 500, 'internal'],
    [new TenantGuardError('missing_tenant_filter', 'x'), 500, 'internal'],
    [new Error('SELECT * FROM secrets'), 500, 'internal'],
    ['a string', 500, 'internal'],
  ])('maps %s', (error, status, code) => {
    const mapped = toApiError(error);
    expect(mapped).toBeInstanceOf(ApiError);
    expect([mapped.status, mapped.code]).toEqual([status, code]);
  });

  it('chooses a supported locale, else English', () => {
    expect(localeOf(undefined)).toBe('en');
    expect(localeOf('ja-JP,ja;q=0.9,en;q=0.8')).toBe('en');
    expect(localeOf('en-GB')).toBe('en');
  });
});
