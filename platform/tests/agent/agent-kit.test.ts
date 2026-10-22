// X03 (ADR-M88 §2.3): the task message of `@sdlc/agent-kit` is the same for every adapter except
// its last rule, which each adapter gives.
import { taskMessage, FINISH_RULE as OPENHANDS_RULE } from '@sdlc/adapter-agent-openhands';
import { FINISH_RULE as OPENCODE_RULE } from '@sdlc/adapter-agent-opencode';
import { buildTaskMessage } from '@sdlc/agent-kit';
import { describe, expect, it } from 'vitest';

import { CONTRACT, TASK } from './helpers';

describe('buildTaskMessage (agent-kit)', () => {
  it('ends with the rule the adapter gives', () => {
    const message = buildTaskMessage(CONTRACT, TASK, '/workspace', { finishRule: '- RULE X' });
    expect(message.split('\n').at(-1)).toBe('- RULE X');
  });

  it('OpenHands and OpenCode differ in the last rule only', () => {
    const openhands = taskMessage(CONTRACT, TASK, '/workspace');
    const opencode = buildTaskMessage(CONTRACT, TASK, '/workspace', { finishRule: OPENCODE_RULE });
    expect(openhands.split('\n').at(-1)).toBe(OPENHANDS_RULE);
    expect(opencode.split('\n').at(-1)).toBe(OPENCODE_RULE);
    expect(openhands.split('\n').slice(0, -1)).toEqual(opencode.split('\n').slice(0, -1));
    expect(OPENCODE_RULE).not.toContain('finish tool');
  });
});
