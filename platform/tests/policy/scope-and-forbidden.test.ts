// D-08 B01 AC4: file scope (G5) and forbidden agent actions (handbook Ch.4 §4.7).
import type { AgentAction } from '@sdlc/contracts';
import { FORBIDDEN_AGENT_ACTIONS, GRANT_REQUIRED_AGENT_ACTIONS } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { engineFor } from './helpers';

const engine = engineFor();

describe('checkScope (G5, N1)', () => {
  const plan = ['apps/api/src/orders/**', 'apps/web/src/views/OrderList.vue', 'docs/*.md'];
  const check = (changedFiles: string[], plannedFiles = plan) =>
    engine.checkScope({ plannedFiles, changedFiles });

  it('accepts files matching exact paths and globs', () => {
    expect(
      check([
        'apps/api/src/orders/orders.service.ts',
        'apps/api/src/orders/dto/create.ts',
        'apps/web/src/views/OrderList.vue',
        'docs/orders.md',
      ]),
    ).toEqual({ withinScope: true, outOfScope: [] });
  });

  it('lists every file outside the plan', () => {
    expect(
      check(['apps/api/src/orders/a.ts', 'apps/api/src/auth/guard.ts', 'docs/specs/t01.md']),
    ).toEqual({
      withinScope: false,
      outOfScope: ['apps/api/src/auth/guard.ts', 'docs/specs/t01.md'],
    });
  });

  it('treats every file as out of scope when the plan is empty', () => {
    expect(check(['README.md'], [])).toEqual({ withinScope: false, outOfScope: ['README.md'] });
  });

  it('accepts no changes', () => {
    expect(check([])).toEqual({ withinScope: true, outOfScope: [] });
  });

  it('never accepts unsafe paths, even with a catch-all pattern', () => {
    const unsafe = [
      '/etc/passwd',
      'apps/api/src/orders/../../../../.github/workflows/ci.yml',
      './apps/api/src/orders/a.ts',
      'apps\\api\\src\\orders\\a.ts',
      'apps//api/x.ts',
      '',
    ];
    expect(check(unsafe, ['**'])).toEqual({ withinScope: false, outOfScope: unsafe });
  });

  it('ignores unsafe plan patterns', () => {
    expect(check(['a.ts'], ['../**', '/**'])).toEqual({ withinScope: false, outOfScope: ['a.ts'] });
  });
});

describe('isForbidden (handbook Ch.4 §4.7)', () => {
  const now = new Date('2026-09-25T10:00:00Z');
  const later = new Date('2026-09-25T11:00:00Z');
  const grant = (mode: 'HITL' | 'HOTL' | 'AUDIT', scope: string, expiresAt = later) => ({
    mode,
    scope,
    expiresAt,
  });
  const forbidden = (action: AgentAction) => engine.isForbidden({ action, now });

  it.each(FORBIDDEN_AGENT_ACTIONS)('%s is forbidden, even with a HITL grant', (kind) => {
    expect(forbidden({ kind })).toBe(true);
    expect(forbidden({ kind, scope: 'x', grant: grant('HITL', 'x') })).toBe(true);
  });

  it.each(GRANT_REQUIRED_AGENT_ACTIONS)('%s needs a HITL grant for its exact scope', (kind) => {
    const scope = 'db:orders';
    expect(forbidden({ kind, scope })).toBe(true);
    expect(forbidden({ kind, scope, grant: grant('HOTL', scope) })).toBe(true);
    expect(forbidden({ kind, scope, grant: grant('AUDIT', scope) })).toBe(true);
    expect(forbidden({ kind, scope, grant: grant('HITL', 'db:*') })).toBe(true);
    expect(forbidden({ kind, grant: grant('HITL', scope) })).toBe(true);
    expect(forbidden({ kind, scope, grant: grant('HITL', scope, now) })).toBe(true);
    expect(forbidden({ kind, scope, grant: grant('HITL', scope) })).toBe(false);
  });

  it('allows ordinary actions', () => {
    expect(forbidden({ kind: 'edit_file', scope: 'apps/api/src/a.ts' })).toBe(false);
  });

  it('uses the current time when none is given', () => {
    const expired = new Date(Date.now() - 1000);
    const action = { kind: 'delete_data', scope: 's', grant: grant('HITL', 's', expired) };
    expect(engine.isForbidden({ action })).toBe(true);
  });
});
