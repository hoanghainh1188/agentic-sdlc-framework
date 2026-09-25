// D-08 B01 AC1: autonomy caps and model routing (D-02 FR-03, design/D-07 section 4,
// QUESTIONS.md #17 and #18).
import type { DataClass, ModelRef } from '@sdlc/contracts';
import { DATA_CLASSES } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { engineFor } from './helpers';

const MODELS: ModelRef[] = [
  { model: 'anthropic/claude-haiku', providerType: 'api' },
  { model: 'anthropic/claude-sonnet', providerType: 'api' },
  { model: 'vllm/qwen-coder', providerType: 'self_hosted' },
];
const engine = engineFor('', MODELS);

describe('maxAutonomy (FR-03)', () => {
  const allowedClasses = DATA_CLASSES.filter((dc) => dc !== 'prohibited');

  it.each([
    ['critical', 'L0'],
    ['high', 'L1'],
    ['medium', 'L2'],
    ['low', 'L2'],
  ] as const)('%s risk → %s for every data class that may use a model', (riskTier, level) => {
    for (const dataClass of allowedClasses) {
      expect(engine.maxAutonomy({ riskTier, dataClass })).toBe(level);
    }
  });

  it('gives L0 for prohibited data at every tier (#18)', () => {
    for (const riskTier of ['low', 'medium', 'high', 'critical'] as const) {
      expect(engine.maxAutonomy({ riskTier, dataClass: 'prohibited' })).toBe('L0');
    }
  });

  it('reads the caps from the configuration', () => {
    const strict = engineFor('autonomy:\n  max_by_risk: { medium: L1, low: L1 }\n');
    expect(strict.maxAutonomy({ riskTier: 'medium', dataClass: 'internal' })).toBe('L1');
  });
});

describe('allowedModels (design/D-07 section 4, #17)', () => {
  const expected: Record<DataClass, string[]> = {
    public: ['anthropic/claude-haiku', 'anthropic/claude-sonnet', 'vllm/qwen-coder'],
    internal: ['anthropic/claude-haiku', 'anthropic/claude-sonnet', 'vllm/qwen-coder'],
    client_confidential: ['anthropic/claude-haiku', 'anthropic/claude-sonnet', 'vllm/qwen-coder'],
    client_restricted: ['vllm/qwen-coder'],
    prohibited: [],
  };

  it.each(DATA_CLASSES)('%s', (dataClass) => {
    expect(engine.allowedModels({ dataClass })).toEqual(expected[dataClass]);
    expect(engine.allowedModels({ dataClass, taskKind: 'hard' })).toEqual(expected[dataClass]);
  });

  it('returns nothing when the gateway lists no models', () => {
    expect(engineFor().allowedModels({ dataClass: 'public' })).toEqual([]);
  });

  it('reads the routing from the configuration', () => {
    const selfHostedOnly = engineFor(
      'model_routing:\n  allowed_provider_types:\n    internal: [self_hosted]\n',
      MODELS,
    );
    expect(selfHostedOnly.allowedModels({ dataClass: 'internal' })).toEqual(['vllm/qwen-coder']);
  });
});
