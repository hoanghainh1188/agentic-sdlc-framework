// Registers and activates an agent for the tests that create runs: since task C10, `runs.agent_id`
// refers to the agent register (QUESTIONS.md #32, migration 0008).
import crypto from 'node:crypto';

import { changeAgentStatus, registerAgent } from '../../packages/core/src/agents/index.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';

export interface SeedAgentOptions {
  readonly version?: string;
  readonly tools?: readonly string[];
  readonly instructionsSha256?: string;
  readonly model?: string;
  /** When the agent is activated (its first certification date). Default: now. */
  readonly activatedAt?: Date;
}

export interface SeededAgent {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly instructionsSha256: string;
  readonly tools: readonly string[];
}

/** An active agent owned by `ownerId`, with a unique key. Returns what a Run Contract needs. */
export async function seedAgent(
  scope: TenantScope,
  ownerId: string,
  options: SeedAgentOptions = {},
): Promise<SeededAgent> {
  const key = `coder-test-${crypto.randomBytes(4).toString('hex')}`;
  const version = options.version ?? '1.0.0';
  const instructionsSha256 = options.instructionsSha256 ?? 'c'.repeat(64);
  const tools = [...new Set(options.tools ?? ['editor'])].sort();
  const agent = await registerAgent(scope, {
    agentKey: key,
    version,
    ownerId,
    modelRef: options.model ?? 'gpt-oss-20b',
    instructionsRef: 'AGENTS.md@v1',
    instructionsSha256,
    allowedTools: tools,
    maxAutonomy: 'L2',
    approvedEnvironments: ['sandbox'],
  });
  await changeAgentStatus(scope, key, {
    to: 'active',
    ...(options.activatedAt ? { now: options.activatedAt } : {}),
  });
  return { id: agent.id, key, version, instructionsSha256, tools };
}
