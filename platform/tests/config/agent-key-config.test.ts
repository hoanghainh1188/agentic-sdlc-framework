// C06 (QUESTIONS #108, ADR-M33 §2.2): the registered agent that runs a project's intents is project
// configuration (`run.agent_key`), not code. None by default: G4 fails until a project sets one.
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

describe('run.agent_key', () => {
  it('is null by default, without a warning', () => {
    const { config, warnings } = loadValid();
    expect(config.run.agent_key).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('accepts an agent key of the register', () => {
    expect(loadValid('run:\n  agent_key: coder-openhands\n').config.run.agent_key).toBe(
      'coder-openhands',
    );
  });

  it.each(['Coder', 'coder_openhands', '-coder', 'coder-', '"a b"', '42'])(
    'refuses %s',
    (value) => {
      expect(keysAndPaths(loadErrors(`run:\n  agent_key: ${value}\n`))[0]?.[1]).toBe(
        'run.agent_key',
      );
    },
  );
});
