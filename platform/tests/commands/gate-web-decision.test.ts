// Tests for U07 web decision source and expected_input_sha256 conflict detection.
import { describe, expect, it, vi } from 'vitest';

import { CommandError } from '../../packages/core/src/commands/errors.js';
import { decideGate, type GateCommand } from '../../packages/core/src/commands/gate-command.js';
import type { Intent } from '../../packages/core/src/db/schema.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';
import type { Registry } from '../../packages/core/src/registry/registry.js';
import { refusalReply } from '../../packages/core/src/commands/git-event-handler.js';

describe('U07 gate web decision & conflict check', () => {
  const dummyIntent: Intent = {
    id: 'i-1',
    code: 'INT-2026-0001',
    project_id: 'p-1',
    status: 'in_gate',
    current_gate: 'G2',
    risk_tier: 'low',
    data_class: 'internal',
    title: 'Test intent',
    description: '',
    budget_usd: '10.0',
    consumed_budget_usd: '0.0',
    issue_number: 1,
    issue_id: '1',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  } as unknown as Intent;

  const mockScope = (actualInputSha: string) => {
    const tx: TenantScope = {
      intents: {
        lockAndGet: vi.fn().mockResolvedValue(dummyIntent),
        get: vi.fn().mockResolvedValue(dummyIntent),
      },
      specRefs: {
        latest: vi.fn().mockResolvedValue({
          content_sha256: actualInputSha,
          acceptance_criteria: 2,
        }),
      },
      specFiles: {
        getForIntent: vi.fn().mockResolvedValue({
          sha256: actualInputSha,
          criteria_sha256: 'c'.repeat(64),
          content: 'test spec',
        }),
      },
      runs: {
        listForIntent: vi.fn().mockResolvedValue([]),
      },
      planFiles: {
        listForIntent: vi.fn().mockResolvedValue([]),
      },
      gateDecisions: {
        listForIntent: vi.fn().mockResolvedValue([]),
      },
      escalations: {
        listForIntent: vi.fn().mockResolvedValue([]),
      },
      roleBindings: {
        listForUser: vi.fn().mockResolvedValue([{ project_id: 'p-1', role: 'developer' }]),
      },
      projectConfigs: {
        get: vi.fn().mockResolvedValue(null),
      },
      transaction: async <T>(cb: (t: TenantScope) => Promise<T>): Promise<T> => cb(tx),
    } as unknown as TenantScope;
    return tx;
  };

  const mockRegistry = (decideSpy: ReturnType<typeof vi.fn>): Registry =>
    ({
      now: () => new Date('2026-10-01T12:00:00Z'),
      decide: decideSpy as unknown as Registry['decide'],
      policyFor: vi.fn().mockResolvedValue({
        policy: {
          evaluateGate: vi.fn().mockReturnValue({ mode: 'HOTL' }),
        },
      }),
    }) as unknown as Registry;

  it('throws gate_input_conflict when expectedInputSha256 does not match', async () => {
    const decideSpy = vi.fn();
    const actualSha = 'a'.repeat(64);
    const staleSha = 'b'.repeat(64);
    const scope = mockScope(actualSha);
    const registry = mockRegistry(decideSpy);

    const command: GateCommand = {
      intent: dummyIntent,
      gate: 'G2',
      decision: 'approve',
      actorId: 'u-1',
      source: 'web',
      expectedInputSha256: staleSha,
    };

    await expect(decideGate(registry, scope, command)).rejects.toThrowError(CommandError);
    await expect(decideGate(registry, scope, command)).rejects.toMatchObject({
      code: 'gate_input_conflict',
    });
    expect(decideSpy).not.toHaveBeenCalled();
  });

  it('records decision with source web when expectedInputSha256 matches', async () => {
    const decideSpy = vi.fn().mockResolvedValue({
      id: 'd-1',
      gate: 'G2',
      decision: 'approve',
      source: 'web',
    });
    const actualSha = 'a'.repeat(64);
    const scope = mockScope(actualSha);
    const registry = mockRegistry(decideSpy);

    const command: GateCommand = {
      intent: dummyIntent,
      gate: 'G2',
      decision: 'approve',
      actorId: 'u-1',
      source: 'web',
      expectedInputSha256: actualSha,
    };

    const res = await decideGate(registry, scope, command);
    expect(res).toBeDefined();
    expect(decideSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        gate: 'G2',
        decision: 'approve',
        source: 'web',
        inputSha256: actualSha,
      }),
    );
  });

  it('maps gate_input_conflict error to failed refusal reply for git comments', () => {
    const error = new CommandError('gate_input_conflict', 'conflict');
    const reply = refusalReply(error, { gate: 'G2' });
    expect(reply).toEqual({ code: 'failed', params: { gate: 'G2' } });
  });
});
