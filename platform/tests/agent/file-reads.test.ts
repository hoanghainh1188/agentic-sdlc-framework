// D-08 X07 AC1 (design/ADR-M90 §2.1): each adapter finds the files its agent opened in its own log.
// Paths become relative to the working dir; opens outside it are only counted, and so are calls
// that can read files without naming them (a shell command, a search).
import { describe, expect, it } from 'vitest';

import { fileReadsOfMessages } from '../../packages/adapters/agent-opencode/src/index.js';
import { fileReads } from '../../packages/adapters/agent-openhands/src/index.js';
import { fileReadsOf, workspacePath } from '../../packages/agent-kit/src/index.js';

describe('workspacePath', () => {
  it('makes paths relative to the working dir, and refuses paths outside it', () => {
    expect(workspacePath('/workspace/src/a.ts', '/workspace')).toBe('src/a.ts');
    expect(workspacePath('src/./b/../a.ts', '/workspace')).toBe('src/a.ts');
    expect(workspacePath('/workspace/', '/workspace')).toBe('');
    expect(workspacePath('.', '/workspace')).toBe('');
    expect(workspacePath('//workspace//src/./a.ts', '/workspace')).toBe('src/a.ts');
    expect(workspacePath('/workspace/src/', '/workspace')).toBe('src');
    expect(workspacePath('a/../../x', '/workspace')).toBeUndefined();
    expect(workspacePath('/workspace/../etc/passwd', '/workspace')).toBeUndefined();
    expect(workspacePath('/etc/passwd', '/workspace')).toBeUndefined();
    expect(workspacePath('/workspace-other/a', '/workspace')).toBeUndefined();
    expect(workspacePath('', '/workspace')).toBeUndefined();
    expect(workspacePath('a\0b', '/workspace')).toBeUndefined();
  });

  it('fileReadsOf: sorted, distinct, outside counted', () => {
    expect(
      fileReadsOf(
        ['/workspace/b.ts', 'a.ts', '/workspace/b.ts', '/tmp/x', '/workspace'],
        '/workspace',
        3,
      ),
    ).toEqual({ paths: ['a.ts', 'b.ts'], outside: 1, unattributed: 3 });
  });
});

describe('OpenHands: file_editor view', () => {
  const action = (tool: string, args: unknown) => ({
    kind: 'ActionEvent',
    tool_name: tool,
    tool_call: { arguments: JSON.stringify(args) },
  });

  it('counts view as a read, terminal as unattributed, and ignores edits', () => {
    const reads = fileReads(
      [
        { kind: 'MessageEvent' },
        action('file_editor', { command: 'view', path: '/workspace/README.md' }),
        action('file_editor', { command: 'view', path: '/workspace/src/app.ts' }),
        action('file_editor', { command: 'view', path: '/workspace/README.md' }),
        action('file_editor', { command: 'create', path: '/workspace/new.ts', file_text: 'x' }),
        action('file_editor', { command: 'view', path: '/etc/hosts' }),
        action('terminal', { command: 'cat package.json' }),
        {
          kind: 'ActionEvent',
          tool_name: 'file_editor',
          action: { command: 'view', path: 'x.md' },
        },
        { kind: 'ActionEvent', tool_name: 'file_editor', tool_call: { arguments: '{not json' } },
        { kind: 'ObservationEvent', tool_name: 'file_editor' },
      ],
      '/workspace',
    );
    expect(reads).toEqual({
      paths: ['README.md', 'src/app.ts', 'x.md'],
      outside: 1,
      unattributed: 1,
    });
  });
});

describe('OpenCode: the read tool', () => {
  const message = (parts: unknown[]) =>
    ({ info: { role: 'assistant' }, parts }) as Parameters<typeof fileReadsOfMessages>[0][number];
  const tool = (name: string, input: unknown) => ({ type: 'tool', tool: name, state: { input } });

  it('counts read as a read; bash, grep, glob and list as unattributed', () => {
    const reads = fileReadsOfMessages(
      [
        message([
          tool('read', { filePath: '/workspace/docs/a.md' }),
          tool('read', { filePath: 'docs/a.md' }),
          tool('read', { filePath: '/root/.ssh/id' }),
          tool('write', { filePath: '/workspace/b.md', content: 'x' }),
          tool('bash', { command: 'cat x' }),
          tool('grep', { pattern: 'x' }),
          tool('glob', { pattern: '*' }),
          tool('list', { path: '.' }),
          { type: 'text', text: 'hello' },
        ]),
      ],
      '/workspace',
    );
    expect(reads).toEqual({ paths: ['docs/a.md'], outside: 1, unattributed: 4 });
  });

  it("never counts the platform's own commit and diff commands", () => {
    const own = 'echo c2RsYw== | base64 -d | sh';
    const messages = [message([tool('bash', { command: own }), tool('bash', { command: 'ls' })])];
    expect(fileReadsOfMessages(messages, '/workspace', [own]).unattributed).toBe(1);
    expect(fileReadsOfMessages(messages, '/workspace').unattributed).toBe(2);
  });
});
