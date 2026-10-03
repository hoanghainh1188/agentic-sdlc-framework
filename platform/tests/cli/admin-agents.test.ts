// `sdlc admin agent …` over the API (B13 AC7, handbook Ch.20, ADR-M37 §2.8) against a mocked
// API: registering with a hashed instructions file, approving (the last approval changes the
// status), stopping, usage errors.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { instructionsSha256 } from '../../packages/core/src/agents/rules.js';
import { EXIT } from '../../apps/cli/src/index.js';
import { agentBody, OTHER_USER, roundBody } from './fixtures.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();
const REGISTER = [
  'admin',
  'agent',
  'register',
  '--key',
  'coder',
  '--version',
  '1.0.0',
  '--owner',
  OTHER_USER,
  '--instructions',
  'AGENTS.md@v1',
  '--max-autonomy',
  'L2',
];

describe('sdlc admin agent', () => {
  it('registers with the hash of a local instructions file', async () => {
    const h = await harness({
      routes: { 'POST /v1/admin/agents': { status: 201, body: agentBody() } },
    });
    const file = join(h.home, 'AGENTS.md');
    await writeFile(file, '# AGENTS\nRun pnpm test.\n');
    expect(
      await h.run([...REGISTER, '--instructions-file', file, '--tools', 'terminal, file_editor']),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({
      key: 'coder',
      version: '1.0.0',
      owner_id: OTHER_USER,
      instructions_sha256: instructionsSha256(Buffer.from('# AGENTS\nRun pnpm test.\n')),
      instructions_ref: 'AGENTS.md@v1',
      allowed_tools: ['terminal', 'file_editor'],
      max_autonomy: 'L2',
    });
    expect(h.out[0]).toBe(
      t('cli.admin.agent.registered', { key: 'coder', version: '1.0.0', status: 'proposed' }),
    );
  });

  it.each([
    [REGISTER],
    [[...REGISTER, '--instructions-sha256', 'a'.repeat(64), '--instructions-file', 'AGENTS.md']],
    [['admin', 'agent', 'approve', '--key', 'coder', '--purpose', 'activate']],
    [['admin', 'agent', 'activate', '--key', 'coder']],
    [['admin', 'agent', 'suspend', '--key', 'coder']],
  ])('prints the usage for %j (exit 2, no request)', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.usage);
    expect(h.requests).toEqual([]);
    expect(h.err).toEqual([t('cli.admin.api.usage')]);
  });

  it('records an approval and says what is still missing; the last one activates', async () => {
    let calls = 0;
    const h = await harness({
      routes: {
        'POST /v1/admin/agents/coder/approvals': () => ({
          status: 200,
          body: roundBody(++calls === 2),
        }),
      },
    });
    const argv = ['admin', 'agent', 'approve', '--key', 'coder', '--purpose', 'activate'];
    expect(await h.run([...argv, '--as', 'owner'])).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ purpose: 'activate', as: 'owner' });
    expect(h.out).toEqual([
      t('cli.admin.agent.approval', {
        key: 'coder',
        version: '1.0.0',
        purpose: 'activate',
        capacity: 'owner',
        missing: 'person_b',
      }),
    ]);
    expect(await h.run([...argv, '--as', 'person_b'])).toBe(EXIT.ok);
    expect(h.out.at(-1)).toBe(
      t('cli.admin.agent.status_changed', { key: 'coder', version: '1.0.0', status: 'active' }),
    );
  });

  it('shows a refusal with the register text (exit 1)', async () => {
    const h = await harness({
      routes: {
        'POST /v1/admin/agents/coder/approvals': apiError(409, 'agent_refused', {
          reason: 'approval_duplicate',
          reason_message: 'Agent coder: you already approved.',
        }),
      },
    });
    expect(
      await h.run([
        'admin',
        'agent',
        'approve',
        '--key',
        'coder',
        '--purpose',
        'activate',
        '--as',
        'owner',
      ]),
    ).toBe(EXIT.failed);
    expect(h.err[1]).toBe(
      t('cli.api.reason', {
        reason: 'approval_duplicate',
        message: 'Agent coder: you already approved.',
      }),
    );
  });

  it('suspends with a reason, lists overdue agents only when asked', async () => {
    const h = await harness({
      routes: {
        'POST /v1/admin/agents/coder/suspend': {
          status: 200,
          body: agentBody({ status: 'suspended' }),
        },
        'GET /v1/admin/agents': {
          status: 200,
          body: {
            items: [
              agentBody({ status: 'active', last_recertified_at: '2026-01-05' }),
              agentBody({
                agent_key: 'fresh',
                status: 'active',
                last_recertified_at: '2026-10-01',
              }),
            ],
          },
        },
      },
    });
    expect(
      await h.run(['admin', 'agent', 'suspend', '--key', 'coder', '--reason', 'incident']),
    ).toBe(EXIT.ok);
    expect(h.requests[0]?.body).toEqual({ reason_code: 'incident' });
    expect(await h.run(['admin', 'agent', 'list', '--overdue', '--json'])).toBe(EXIT.ok);
    const listed = JSON.parse(h.out.at(-1) ?? '{}') as { items: { key: string }[] };
    expect(listed.items.map((agent) => agent.key)).toEqual(['coder']);
  });
});
