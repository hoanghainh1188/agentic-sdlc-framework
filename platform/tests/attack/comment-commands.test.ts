// D-08 H01 AC2, AC3 (ADR-M80 U-3): attacks through GitHub comments, without a database. A comment
// is text from anyone on the Git host; only a linked, active person with a role can turn it into a
// decision. Here the handler runs on a scope made of small fakes that fail on any call the test did
// not expect, so a refused comment is proved to have written nothing and asked nothing further.
// The same rules on PostgreSQL: tests/integration/db/git-poller.test.ts (B06) and gate-g7.test.ts.
import type { CommentCreatedEvent } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  parseCommentCommand,
  requestChangesReason,
} from '../../packages/core/src/commands/comment-command.js';
import { handleGitEvent } from '../../packages/core/src/commands/git-event-handler.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';
import type { Registry } from '../../packages/core/src/registry/registry.js';

const PROJECT = { id: 'p-1', provider: 'github' as const };
const INTENT = { id: 'i-1', code: 'INT-2026-0001', project_id: PROJECT.id };
const DEPS = { registry: {} as Registry, now: () => new Date('2026-10-13T08:00:00Z') };

interface World {
  /** Linked accounts: numeric account ID → { user, status }. */
  readonly accounts: Readonly<Record<string, { user: string; status: string }>>;
  /** Roles by user. */
  readonly roles: Readonly<Record<string, readonly string[]>>;
}

interface Run {
  readonly outcome: string;
  readonly reply: string | null;
  readonly decisions: number;
  readonly touched: readonly string[];
}

/** A scope that answers only what the handler may ask; anything else throws and fails the test. */
function scopeOf(world: World): { scope: TenantScope; log: string[]; receipts: unknown[] } {
  const log: string[] = [];
  const receipts: unknown[] = [];
  const guarded = (name: string, impl: Record<string, unknown>): unknown =>
    new Proxy(impl, {
      get: (target, prop: string) => {
        if (prop in target) {
          log.push(`${name}.${prop}`);
          return target[prop];
        }
        throw new Error(`unexpected call ${name}.${String(prop)}`);
      },
    });
  const tx = {
    gitEventReceipts: guarded('gitEventReceipts', {
      find: () => Promise.resolve(undefined),
      record: (input: unknown) => {
        receipts.push(input);
        return Promise.resolve(input);
      },
    }),
    userIdentities: guarded('userIdentities', {
      findByExternalId: (_p: string, id: string) =>
        Promise.resolve(world.accounts[id] ? { user_id: world.accounts[id].user } : undefined),
    }),
    users: guarded('users', {
      getById: (id: string) => {
        const found = Object.values(world.accounts).find((a) => a.user === id);
        return Promise.resolve(found ? { id, status: found.status } : undefined);
      },
    }),
    intents: guarded('intents', { findOpenByGitNumber: () => Promise.resolve([INTENT]) }),
    roleBindings: guarded('roleBindings', {
      listForUser: (user: string) =>
        Promise.resolve(
          (world.roles[user] ?? []).map((role) => ({ project_id: PROJECT.id, role })),
        ),
    }),
    projectConfigs: guarded('projectConfigs', { get: () => Promise.resolve(undefined) }),
    savepoint: <T>(fn: (sp: unknown) => Promise<T>) => fn(tx),
  };
  const scope = { transaction: <T>(fn: (t: unknown) => Promise<T>) => fn(tx) };
  return { scope: scope as unknown as TenantScope, log, receipts };
}

function comment(body: string, author: { id: string; type?: 'user' | 'bot' }): CommentCreatedEvent {
  return {
    kind: 'comment_created',
    id: 'github:comment:1',
    source: 'polling',
    repo: { owner: 'org', name: 'repo' },
    occurredAt: '2026-10-13T08:00:00Z',
    url: 'https://github.com/org/repo/pull/7#issuecomment-1',
    issueNumber: 7,
    isPullRequest: true,
    commentId: '1',
    author: { id: author.id, login: 'someone', type: author.type ?? 'user' },
    body,
  };
}

async function run(world: World, event: CommentCreatedEvent): Promise<Run> {
  const { scope, log, receipts } = scopeOf(world);
  const handled = await handleGitEvent(scope, DEPS, PROJECT, event);
  const receipt = receipts[0] as { reply?: { code: string } } | undefined;
  return {
    outcome: handled.outcome,
    reply: receipt?.reply?.code ?? null,
    decisions: handled.intentId === undefined ? 0 : 1,
    touched: log,
  };
}

const WORLD: World = {
  accounts: {
    '100': { user: 'u-b', status: 'active' }, // Person B
    '200': { user: 'u-viewer', status: 'active' },
    '300': { user: 'u-gone', status: 'disabled' },
  },
  roles: { 'u-b': ['person_b'], 'u-viewer': ['viewer'] },
};

describe('comment attacks: who can turn a comment into a decision (U-3)', () => {
  it('a bot never decides, even with the numeric ID of Person B, and gets no reply', async () => {
    const result = await run(WORLD, comment('/approve G3', { id: '100', type: 'bot' }));
    expect(result).toMatchObject({ outcome: 'ignored_bot', reply: null, decisions: 0 });
    // It never looked the account up.
    expect(result.touched.filter((t) => t.startsWith('userIdentities'))).toEqual([]);
  });

  it('an account that is not linked to a platform user decides nothing', async () => {
    const result = await run(WORLD, comment('/approve G3', { id: '9999' }));
    expect(result).toMatchObject({
      outcome: 'user_not_linked',
      reply: 'user_not_linked',
      decisions: 0,
    });
    expect(result.touched.filter((t) => t.startsWith('roleBindings'))).toEqual([]);
  });

  it('a disabled user decides nothing', async () => {
    const result = await run(WORLD, comment('/approve G3', { id: '300' }));
    expect(result).toMatchObject({ outcome: 'user_not_linked', decisions: 0 });
  });

  it('a linked account with no role on the project learns nothing (intent_not_found)', async () => {
    const world: World = { ...WORLD, roles: {} };
    const result = await run(world, comment('/approve G3', { id: '100' }));
    expect(result).toMatchObject({ outcome: 'refused', reply: 'intent_not_found', decisions: 0 });
  });

  it('/approve G7 is refused for Person B too: G7 approvals are reviews of the pushed commit', async () => {
    const result = await run(WORLD, comment('/approve G7', { id: '100' }));
    expect(result).toMatchObject({ outcome: 'refused', reply: 'g7_use_pr_review', decisions: 0 });
    // No decision was written: the fake scope has no repository for it, and any call would throw.
  });

  it.each(['/approve g7', '  \n\n/APPROVE G7\n\nLGTM', '/Approve   G07'])(
    '/approve G7 written as %j is refused the same way',
    async (body) => {
      const result = await run(WORLD, comment(body, { id: '100' }));
      // G07 is read as G7 by the grammar (Number("07")); a refusal is the safe answer either way.
      expect(['g7_use_pr_review', 'gate_invalid'].includes(result.reply ?? '')).toBe(true);
      expect(result.decisions).toBe(0);
    },
  );
});

describe('comment attacks: text that looks like a command but is not (U-3)', () => {
  it.each([
    ['a quoted reply', '> /approve G7\nlooks fine'],
    ['a command after other text', 'Thanks!\n/approve G3'],
    ['a code fence', '```\n/approve G3\n```'],
    ['a full-width slash', '／approve G3'],
    ['a zero-width character in the verb', '/appro​ve G3'],
    ['a bidirectional character before the slash', '‮/approve G3'],
    ['a look-alike verb', '/approved G3'],
    ['a markdown escape', '\\/approve G3'],
  ])('%s is not a command', (_name, body) => {
    expect(parseCommentCommand(body)).toEqual({ kind: 'none' });
  });

  it('an approval with extra words is invalid, not an approval', () => {
    expect(parseCommentCommand('/approve G3 if the tests pass')).toMatchObject({
      kind: 'invalid',
      problem: 'unexpected_text',
    });
    expect(parseCommentCommand('/approve G3 G7')).toMatchObject({ kind: 'invalid' });
  });

  it('a comment edited after the platform read it is not the request for changes any more', () => {
    const original = '/request-changes G7 tests_insufficient\nAdd a test for AC3.';
    expect(requestChangesReason(original, 'G7')).toContain('Add a test for AC3.');
    // The author edits it into something else (or into an approval): the runner checks again.
    expect(requestChangesReason('/approve G3', 'G7')).toBeNull();
    expect(requestChangesReason('Never mind, looks fine.', 'G7')).toBeNull();
    expect(requestChangesReason('/request-changes G3 other\nwrong gate', 'G7')).toBeNull();
  });

  it('a comment from a person that is not a command writes nothing and asks nothing', async () => {
    const result = await run(WORLD, comment('Please /approve G3 for me', { id: '100' }));
    expect(result).toMatchObject({ outcome: 'not_a_command', decisions: 0 });
    expect(result.touched).toEqual([]);
  });
});
