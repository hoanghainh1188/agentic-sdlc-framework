// The adapter accepts only a configuration validated by `@sdlc/config` (ADR-M18 §2.2): the
// mandatory rules M1–M15 run once, when the configuration is loaded, never in the adapter.
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import { defaultProjectConfig, loadProjectConfig } from '@sdlc/config';
import type { ProjectConfig } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

describe('createSimplePolicyEngine', () => {
  it('accepts the default and loaded configurations', () => {
    const loaded = loadProjectConfig('');
    if (!loaded.ok) throw new Error('default configuration must load');
    expect(createSimplePolicyEngine({ config: loaded.config })).toBeDefined();
    expect(createSimplePolicyEngine({ config: defaultProjectConfig() })).toBeDefined();
  });

  it('does not compile with an unvalidated configuration', () => {
    const raw: ProjectConfig = defaultProjectConfig();
    // @ts-expect-error a plain ProjectConfig has not passed the mandatory rules
    expect(createSimplePolicyEngine({ config: raw })).toBeDefined();
  });

  it('never loads a configuration that loosens a mandatory rule', () => {
    expect(
      loadProjectConfig('oversight:\n  matrix:\n    G7:\n      low: { mode: HOTL }\n').ok,
    ).toBe(false);
  });
});
