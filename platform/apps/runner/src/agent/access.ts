// How the runner reaches the Agent Server in a sandbox (C05, ADR-M25 §5, ADR-M29).
//
// The sandbox publishes no port and sits on its own internal network (ADR-M25 §2.2). The runner
// joins that network with its own container, calls `http://sdlc-sandbox-<run_id>:<port>`, and
// leaves at clean-up (`teardownSandbox` detaches every container still attached).
//
// - Only the runner's own container may join (guard `assertSafeNetworkConnect`).
// - The runner listens on no port, so joining the network gives the sandbox nothing to reach.
// - Every Agent Server call carries the per-run session key, which only the runner holds: LiteLLM,
//   the package proxy or anything else on the network cannot call the API (ADR-M29).
import type { AgentEndpoint, RedactedSecret } from '@sdlc/contracts';

import type { DockerClient } from '../docker/client.js';
import { assertSafeNetworkConnect } from '../docker/guard.js';
import { runNames } from '../names.js';
import type { Sandbox } from '../sandbox/lifecycle.js';
import type { RunnerSettings } from '../settings.js';
import { AgentRunError } from './errors.js';

/** A secret held in memory; `toString` and JSON never show the value. */
class SessionKey implements RedactedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }
}

/** The Agent Server URL of a run, as the runner sees it on the run's network. */
export function agentUrl(runId: string, settings: RunnerSettings): string {
  return `http://${runNames(runId).container}:${String(settings.agent.port)}`;
}

/**
 * Attaches the runner's container to the run's network (no alias) and returns the endpoint.
 * Idempotent: an attachment that already exists is kept.
 */
export async function attachRunner(
  docker: DockerClient,
  settings: RunnerSettings,
  sandbox: Sandbox,
  baseUrl = agentUrl(sandbox.names.runId, settings),
): Promise<AgentEndpoint> {
  const self = settings.agent.selfContainer;
  if (!self) throw new AgentRunError('runner_not_attachable');
  assertSafeNetworkConnect(sandbox.names.network, self, [self]);
  const network = await docker.networkInspect(sandbox.names.network);
  if (!network) throw new AgentRunError('runner_not_attachable');
  const attached = Object.values(network.Containers ?? {}).some((c) => c.Name === self);
  if (!attached) await docker.networkConnect(sandbox.names.network, self, []);
  return { baseUrl, sessionKey: new SessionKey(sandbox.sessionApiKey) };
}
