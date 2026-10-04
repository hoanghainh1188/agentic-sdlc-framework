// C11 PR 2 (D-02 FR-35, design/ADR-M42 §2.7): identical tool calls = the same tool and the same
// SHA-256 of the RFC 8785 canonical arguments, volatile fields left out. The adapter's own
// canonicaliser gives the same text as `@sdlc/config` for JSON data, and never throws on the
// agent's input.
import {
  canonicalArguments,
  toolCallKey,
  trailingIdenticalCalls,
} from '@sdlc/adapter-agent-openhands';
import { canonicalJson } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

const call = (args: unknown, extra: Record<string, unknown> = {}) => ({
  kind: 'ActionEvent',
  tool_name: 'terminal',
  tool_call: { id: `call_${String(Math.random())}`, arguments: args },
  ...extra,
});

describe('canonicalArguments', () => {
  const samples: unknown[] = [
    null,
    true,
    0,
    -0,
    1e21,
    1.5e-7,
    'é "\\\n',
    [],
    {},
    { b: 1, a: [3, { d: null, c: 'x' }] },
    { é: 1, e: 2, E: 3, '😀': 4, '€': 5 },
    { nested: { list: [1, 'two', false, { z: 0, y: [] }] } },
  ];

  it.each(samples.map((value) => [JSON.stringify(value), value]))(
    'equals @sdlc/config canonicalJson for %s',
    (_, value) => {
      expect(canonicalArguments(value, false)).toBe(canonicalJson(value));
    },
  );

  it('drops the volatile fields at every depth', () => {
    expect(canonicalArguments({ command: 'ls', summary: 'x', inner: { kind: 'y', a: 1 } })).toBe(
      '{"command":"ls","inner":{"a":1}}',
    );
  });

  it('never throws on arguments nested deeper than the stack allows (code review)', () => {
    const deep = `${'['.repeat(20_000)}${']'.repeat(20_000)}`;
    expect(() => toolCallKey(call(deep))).not.toThrow();
    expect(toolCallKey(call(deep))).toBe(toolCallKey(call(deep)));
    expect(canonicalArguments([[[[1]]]])).toBe('[[[[1]]]]');
  });

  it('never throws on input that is not JSON data', () => {
    expect(canonicalArguments({ a: Number.NaN, b: '\ud800', c: () => 1, d: undefined })).toBe(
      '{"a":null,"b":"�","c":null}',
    );
  });
});

describe('toolCallKey', () => {
  it('is the same for string and object arguments, whatever the key order or call ID', () => {
    expect(toolCallKey(call('{"command":"ls","path":"/w"}'))).toBe(
      toolCallKey(call({ path: '/w', command: 'ls' })),
    );
  });

  it('ignores volatile fields (summary, security_risk) but not real arguments', () => {
    expect(toolCallKey(call({ command: 'ls', summary: 'a', security_risk: 'LOW' }))).toBe(
      toolCallKey(call({ command: 'ls', summary: 'b', security_risk: 'HIGH' })),
    );
    expect(toolCallKey(call({ command: 'ls' }))).not.toBe(toolCallKey(call({ command: 'ls -a' })));
  });

  it('differs by tool', () => {
    expect(toolCallKey(call({ command: 'ls' }))).not.toBe(
      toolCallKey(call({ command: 'ls' }, { tool_name: 'file_editor' })),
    );
  });

  it('falls back to the action when there are no tool-call arguments', () => {
    const a = { kind: 'ActionEvent', tool_name: 'terminal', action: { command: 'ls' } };
    expect(toolCallKey(a)).toBe(toolCallKey({ ...a, action: { command: 'ls', kind: 'X' } }));
  });

  it('holds a hash, never the arguments', () => {
    expect(toolCallKey(call({ command: 'cat secret.txt' }))).toMatch(/^terminal\|[0-9a-f]{64}$/);
  });
});

describe('trailingIdenticalCalls', () => {
  const ls = call({ command: 'ls' });
  const pwd = call({ command: 'pwd' });
  const observation = { kind: 'ObservationEvent' };

  it('is 0 without a tool call', () => {
    expect(trailingIdenticalCalls([])).toBe(0);
    expect(trailingIdenticalCalls([{ kind: 'MessageEvent' }, observation])).toBe(0);
  });

  it('counts the run of identical calls at the end; other events between them do not break it', () => {
    expect(trailingIdenticalCalls([ls, observation, ls, observation, ls, observation])).toBe(3);
  });

  it('stops at the first different call', () => {
    expect(trailingIdenticalCalls([ls, ls, pwd, ls, ls])).toBe(2);
    expect(trailingIdenticalCalls([ls, ls, ls, pwd])).toBe(1);
  });
});
