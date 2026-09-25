import { describe, expect, it } from 'vitest';

import { actionKey, isLooping, trailingIdenticalCalls } from '../src/loop-detector.ts';
import { loadSpikeSettings } from '../src/spike-settings.ts';
import { isTerminal, toRunStatus } from '../src/status-map.ts';

const ls = { kind: 'ActionEvent', tool_name: 'terminal', action: { command: 'ls', summary: 'a' } };
const cat = { kind: 'ActionEvent', tool_name: 'terminal', action: { command: 'cat x' } };
const observation = { kind: 'ObservationEvent', tool_name: 'terminal' };

describe('loop detection (FR-35) with the limit from config', () => {
  const limit = loadSpikeSettings().identicalToolCallsMax;

  it('reads the handbook limit from project config (3)', () => {
    expect(limit).toBe(3);
  });

  it('stops after more than the limit of identical consecutive calls', () => {
    const events = (n: number) => Array.from({ length: n }, () => [ls, observation]).flat();
    expect(isLooping(events(limit), limit)).toBe(false);
    expect(isLooping(events(limit + 1), limit)).toBe(true);
  });

  it('counts only the trailing run of identical calls', () => {
    expect(trailingIdenticalCalls([ls, ls, cat, ls, ls])).toBe(2);
    expect(trailingIdenticalCalls([])).toBe(0);
  });

  it('ignores volatile fields and prefers the raw tool-call arguments', () => {
    const other = { ...ls, action: { command: 'ls', summary: 'different words' } };
    expect(actionKey(other)).toBe(actionKey(ls));
    const text = { kind: 'ActionEvent', tool_name: 't', tool_call: { arguments: '{"b":2,"a":1}' } };
    const object = {
      kind: 'ActionEvent',
      tool_name: 't',
      tool_call: { arguments: { a: 1, b: 2 } },
    };
    const different = {
      kind: 'ActionEvent',
      tool_name: 't',
      tool_call: { arguments: { a: 1, b: 3 } },
    };
    expect(actionKey(text)).toBe(actionKey(object));
    expect(actionKey(different)).not.toBe(actionKey(object));
    expect(isLooping([object, text, object, text], 3)).toBe(true);
    expect(isLooping([object, text, different, text], 3)).toBe(false);
  });
});

describe('Agent Server status → D-05 run_status', () => {
  it('maps normal endings', () => {
    expect(toRunStatus('finished', {})).toBe('succeeded');
    expect(toRunStatus('error', {})).toBe('failed');
    expect(toRunStatus('stuck', {})).toBe('stopped_stalled');
    expect(toRunStatus('running', {})).toBe('running');
    expect(toRunStatus('deleting', {})).toBe('stopping');
  });

  it('maps a pause by the platform to the reason of the stop', () => {
    expect(toRunStatus('paused', { stopReason: 'kill' })).toBe('stopped_killed');
    expect(toRunStatus('paused', { stopReason: 'loop' })).toBe('stopped_stalled');
    expect(toRunStatus('paused', { stopReason: 'timeout' })).toBe('stopped_timeout');
    expect(toRunStatus('paused', {})).toBe('failed');
  });

  it('knows which states end a run', () => {
    expect(isTerminal('finished')).toBe(true);
    expect(isTerminal('stuck')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('idle')).toBe(false);
  });
});
