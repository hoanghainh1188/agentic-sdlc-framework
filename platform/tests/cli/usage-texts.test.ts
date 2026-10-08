// The top-level usage texts list exactly the commands the CLI implements (docs review 2026-10-08:
// `cli.ops.usage` named agent commands that ops never had, `cli.usage` missed `evidence`).
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { ADMIN_API_GROUPS } from '../../apps/cli/src/commands/admin-api.js';
import { OPS_AGENT_COMMANDS } from '../../apps/cli/src/commands/ops-agent.js';
import { USER_COMMAND_GROUPS } from '../../apps/cli/src/index.js';

const sorted = (items: Iterable<string>): string[] => [...new Set(items)].sort();

describe('CLI usage texts', () => {
  it('cli.usage names every command group, and only those', () => {
    const groups = [...t('cli.usage').matchAll(/^ {4}sdlc ([a-z-]+)/gm)].map((m) => m[1] ?? '');
    expect(sorted(groups)).toEqual(sorted([...USER_COMMAND_GROUPS, 'audit', 'ops']));
  });

  it('cli.usage lists every sdlc admin group, and only those', () => {
    const line = /sdlc admin ([a-z|-]+) …/.exec(t('cli.usage'));
    expect(sorted(line?.[1]?.split('|') ?? [])).toEqual(sorted(ADMIN_API_GROUPS));
  });

  it('cli.ops.usage lists exactly the sdlc ops agent commands', () => {
    const line = /sdlc ops agent ([a-z|]+) …/.exec(t('cli.ops.usage'));
    expect(sorted(line?.[1]?.split('|') ?? [])).toEqual(sorted(OPS_AGENT_COMMANDS));
  });
});
