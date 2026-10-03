// Pure parts of admin onboarding (B13, ADR-M37): conflicting roles (QUESTIONS #154), the warning
// codes of `config.changed` (AC4), the audit `codes` field, and the shape checks every caller
// shares (AC3: a Git host account is its numeric ID, never a login).
import { loadProjectConfig } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import {
  checkBranch,
  checkEmail,
  checkName,
  checkPattern,
  EXTERNAL_ID_PATTERN,
  EXTERNAL_LOGIN_PATTERN,
  REPO_FULL_NAME_PATTERN,
} from '../../packages/core/src/admin/validation.js';
import { warningCodes } from '../../packages/core/src/admin/config.js';
import { AdminError } from '../../packages/core/src/admin/errors.js';
import { conflictingRole } from '../../packages/core/src/admin/roles.js';
import { checkAuditEvent, MAX_AUDIT_CODES } from '../../packages/core/src/audit/actions.js';
import { overrideSha256 } from '../../packages/core/src/db/repositories/project-configs.js';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);

describe('conflicting roles (QUESTIONS #154)', () => {
  const pairs = [
    ['person_a', 'person_b'],
    ['person_b', 'second_approver'],
  ] as const;

  it.each([
    [['person_a'], 'person_b', 'person_a'],
    [['person_b'], 'person_a', 'person_b'],
    [['second_approver'], 'person_b', 'second_approver'],
    [['person_b'], 'second_approver', 'person_b'],
    [['viewer', 'pm_brse'], 'person_b', undefined],
    [['person_a'], 'second_approver', undefined],
    [[], 'person_a', undefined],
  ] as const)('holding %j, granting %s conflicts with %s', (held, role, expected) => {
    expect(conflictingRole(pairs, held, role)).toBe(expected);
  });

  it('the default configuration keeps Person A and Person B apart (rule M21)', () => {
    const loaded = loadProjectConfig('');
    expect(loaded.ok && loaded.config.access.conflicting_roles).toEqual([
      ['person_a', 'person_b'],
      ['person_b', 'second_approver'],
    ]);
  });

  it('accepts the pair in any order, and refuses a pair of the same role or of three roles', () => {
    expect(loadProjectConfig('access:\n  conflicting_roles: [[person_b, person_a]]\n').ok).toBe(
      true,
    );
    for (const pair of ['[person_a, person_a]', '[person_a, person_b, viewer]', '[person_a]']) {
      const yaml = `access:\n  conflicting_roles: [[person_a, person_b], ${pair}]\n`;
      expect(loadProjectConfig(yaml).ok, pair).toBe(false);
    }
  });
});

describe('warning codes of config.changed (AC4)', () => {
  it('are <warning>:<path>, in the audit code format, at most 16', () => {
    const loaded = loadProjectConfig(
      'oversight:\n  matrix:\n    G2:\n      medium: { mode: HOTL, roles: [person_a], approvals: 1 }\n',
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(warningCodes(loaded.warnings)).toEqual([
      'mode_loosened:oversight.matrix.G2.medium.mode',
    ]);
    const many = Array.from({ length: 30 }, (_, i) => ({
      key: 'config.warning.mode_loosened' as const,
      path: `a[${String(i)}].${'x'.repeat(80)}`,
      params: {},
    }));
    const codes = warningCodes(many);
    expect(codes).toHaveLength(MAX_AUDIT_CODES);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
  });

  it('pass the audit check, and an empty or too long list is refused', () => {
    const payload = {
      version: 2,
      config_hash: HASH,
      override_sha256: HASH,
      cause: 'upload',
      warning_count: 1,
      warnings: ['mode_loosened:oversight.matrix.G2.medium.mode'],
    };
    expect(checkAuditEvent('config.changed', PROJECT_ID, payload).payload).toEqual(payload);
    for (const warnings of [[], Array.from({ length: 17 }, () => 'a'), ['has space'], 'a']) {
      expect(() => checkAuditEvent('config.changed', PROJECT_ID, { ...payload, warnings })).toThrow(
        /warnings must be a codes/,
      );
    }
  });

  it('the YAML hash is SHA-256 of the UTF-8 text', () => {
    expect(overrideSha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(overrideSha256('a: 1')).not.toBe(overrideSha256('a: 1 '));
  });
});

describe('admin value checks (AC2, AC3)', () => {
  const field = (fn: () => unknown): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (error) {
      return error instanceof AdminError ? error.extra.field : 'not an AdminError';
    }
  };

  it('a Git host account is its numeric ID, never a login (QUESTIONS #45)', () => {
    for (const ok of ['1', '583231', '12345678901234567890']) {
      expect(EXTERNAL_ID_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of ['octocat', '0', '012', '-1', '1.5', '', '123456789012345678901']) {
      expect(
        field(() => checkPattern('external_id', bad, EXTERNAL_ID_PATTERN)),
        bad,
      ).toBe('external_id');
    }
    expect(EXTERNAL_LOGIN_PATTERN.test('octo-cat')).toBe(true);
    expect(EXTERNAL_LOGIN_PATTERN.test('-octo')).toBe(false);
  });

  it('repositories, branches, names and e-mail addresses', () => {
    expect(REPO_FULL_NAME_PATTERN.test('harryforge/pilot-order-inventory')).toBe(true);
    for (const bad of ['pilot', 'a/b/c', '../x', 'a b/c']) {
      expect(REPO_FULL_NAME_PATTERN.test(bad), bad).toBe(false);
    }
    expect(checkBranch('release/1.2')).toBe('release/1.2');
    for (const bad of ['a..b', 'x/', 'x.lock', 'x.', '-x', 'a b', 'a//b']) {
      expect(
        field(() => checkBranch(bad)),
        bad,
      ).toBe('default_branch');
    }
    expect(checkName('name', '  Pilot  ')).toBe('Pilot');
    expect(field(() => checkName('name', ' '))).toBe('name');
    expect(field(() => checkName('name', 'a\u0007b'))).toBe('name');
    expect(checkEmail(' a@example.test ')).toBe('a@example.test');
    expect(field(() => checkEmail('not-an-address'))).toBe('email');
  });
});
