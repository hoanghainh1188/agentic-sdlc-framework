// One PoC run: virtual key → sandbox → relay → conversation → results → kill / clean-up.
// This is the shape C04 (runner) and C05 (OpenHands adapter) will need; the spike code may be
// thrown away (design/ADR-M10).
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

import { AgentServerClient, type AgentEvent } from './agent-server-client.ts';
import { type CostLabels, LiteLlmAdmin } from './litellm-admin.ts';
import { isLooping } from './loop-detector.ts';
import {
  POC_SANDBOX_LIMITS,
  removeContainer,
  startRelay,
  startSandbox,
  type SandboxLimits,
} from './sandbox.ts';
import type { SpikeSettings } from './spike-settings.ts';
import { isTerminal, type ExecutionStatus } from './status-map.ts';

export const WORKING_DIR = '/workspace/project';
/** LiteLLM as seen from the sandbox: compose service name on the internal network. */
export const LITELLM_URL_IN_SANDBOX = 'http://litellm:4000';
export const SRC_DIR = path.dirname(new URL(import.meta.url).pathname);

export interface PocRunOptions {
  admin: LiteLlmAdmin;
  settings: SpikeSettings;
  modelAlias: string;
  budgetUsd: number;
  readOnlyRoot: boolean;
  limits?: SandboxLimits;
  /** OpenHands' built-in stuck detector; default on. */
  stuckDetection?: boolean;
}

export interface WaitResult {
  status: ExecutionStatus;
  events: AgentEvent[];
  loopDetected: boolean;
  timedOut: boolean;
  elapsedMs: number;
}

export function pocLabels(runId: string, agent = 'coder-openhands'): CostLabels {
  return {
    tenant: 'poc-tenant',
    project: 'poc-project',
    intent_id: 'INT-2026-9999',
    run_id: runId,
    gate: 'G4',
    agent,
    data_class: 'internal',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PocRun {
  readonly runId = randomUUID();
  readonly sandboxName = `sdlc-poc-${this.runId.slice(0, 8)}`;
  readonly relayName = `${this.sandboxName}-relay`;
  readonly sessionKey = randomBytes(24).toString('base64url');
  readonly labels = pocLabels(this.runId);
  virtualKey = '';
  client!: AgentServerClient;
  conversationId = '';

  constructor(private readonly options: PocRunOptions) {}

  /** Creates the key and the containers, waits for the API, and creates a git fixture repo. */
  async start(): Promise<this> {
    this.virtualKey = await this.options.admin.createRunKey({
      labels: this.labels,
      models: [this.options.modelAlias],
      maxBudgetUsd: this.options.budgetUsd,
      durationMinutes: this.options.settings.keyDurationMinutes,
    });
    await startSandbox({
      name: this.sandboxName,
      runId: this.runId,
      limits: this.options.limits ?? POC_SANDBOX_LIMITS,
      readOnlyRoot: this.options.readOnlyRoot,
      env: {
        SESSION_API_KEY: this.sessionKey,
        OH_SECRET_KEY: randomBytes(32).toString('base64url'),
        OH_ENABLE_VSCODE: 'false',
        OH_TELEMETRY_EXPORTER: 'none',
        DO_NOT_TRACK: '1',
        OPENHANDS_SUPPRESS_BANNER: '1',
      },
    });
    const port = await startRelay(this.relayName, this.sandboxName, SRC_DIR);
    this.client = new AgentServerClient(`http://127.0.0.1:${port}`, this.sessionKey);
    await this.waitReady(120_000);
    await this.seedWorkspace();
    return this;
  }

  private async waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.client.isReady()) return;
      await sleep(1_000);
    }
    throw new Error(`Agent Server in ${this.sandboxName} was not ready within ${timeoutMs} ms`);
  }

  private async seedWorkspace(): Promise<void> {
    const script = [
      `mkdir -p ${WORKING_DIR}`,
      `cd ${WORKING_DIR}`,
      'git init -q -b main',
      'git config user.email poc@example.invalid',
      'git config user.name "C01 PoC"',
      'printf "# PoC fixture\\n" > README.md',
      'git add -A',
      'git commit -qm "fixture: initial commit"',
    ].join(' && ');
    const result = await this.client.executeBash(script, '/workspace');
    if (result.exit_code !== 0) {
      throw new Error(`fixture setup failed (exit ${result.exit_code}): ${result.stderr ?? ''}`);
    }
  }

  async startTask(task: string): Promise<void> {
    const conversation = await this.client.startConversation({
      llm: {
        modelAlias: this.options.modelAlias,
        baseUrl: LITELLM_URL_IN_SANDBOX,
        virtualKey: this.virtualKey,
        usageId: `run-${this.runId}`,
      },
      workingDir: WORKING_DIR,
      task: `${task}\nWorking directory: ${WORKING_DIR}`,
      maxIterations: this.options.settings.maxIterations,
      labels: { ...this.labels },
      stuckDetection: this.options.stuckDetection ?? true,
    });
    this.conversationId = conversation.id;
  }

  /**
   * Polls status and events until the conversation ends, the loop limit from config is passed
   * (then it interrupts: FR-35), or the time cap is reached (then it interrupts: FR-32).
   */
  async waitForEnd(timeoutMs: number, pollMs = 1_000): Promise<WaitResult> {
    const started = Date.now();
    for (;;) {
      const { executionStatus } = await this.client.getConversation(this.conversationId);
      const events = await this.client.listEvents(this.conversationId);
      const elapsedMs = Date.now() - started;
      if (isTerminal(executionStatus)) {
        return { status: executionStatus, events, loopDetected: false, timedOut: false, elapsedMs };
      }
      const looping = isLooping(events, this.options.settings.identicalToolCallsMax);
      if (looping || elapsedMs > timeoutMs) {
        await this.client.interrupt(this.conversationId);
        const after = await this.client.getConversation(this.conversationId);
        return {
          status: after.executionStatus,
          events,
          loopDetected: looping,
          timedOut: !looping,
          elapsedMs,
        };
      }
      await sleep(pollMs);
    }
  }

  /** Kill switch (FR-34): remove the sandbox, then revoke the virtual key. Returns the time taken. */
  async kill(): Promise<number> {
    const started = Date.now();
    await removeContainer(this.sandboxName);
    if (this.virtualKey) await this.options.admin.deleteKey(this.virtualKey);
    return Date.now() - started;
  }

  async cleanup(): Promise<void> {
    await removeContainer(this.relayName);
    await removeContainer(this.sandboxName);
    if (this.virtualKey) await this.options.admin.deleteKey(this.virtualKey).catch(() => undefined);
  }
}
