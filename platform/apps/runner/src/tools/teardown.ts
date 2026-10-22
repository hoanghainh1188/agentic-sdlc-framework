// Removing a run's register tools and its MCP gateway (task X04, design/ADR-M69 §2.8). Called by
// `teardownSandbox` before the sandbox, so the end of a run, a kill, a failure, the clean-up after a
// restart and the orphan sweep all remove them.
import type { DockerClient } from '../docker/client.js';
import { toolObjectNames } from '../names.js';

/**
 * Removes a run's gateway first (every tool is cut at once, ADR-M69 §2.8), then its tool
 * containers, its tool network and the gateway's config volume. Idempotent; every step runs, the
 * first error is thrown at the end. Tool containers are found by the run's label and their name.
 */
export async function teardownTools(
  docker: DockerClient,
  runId: string,
  runLabel: Readonly<Record<string, string>>,
): Promise<void> {
  const names = toolObjectNames(runId);
  let firstError: Error | undefined;
  const attempt = async (step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      firstError ??= error instanceof Error ? error : new Error('tool teardown failed');
    }
  };
  await attempt(() => docker.containerRemove(names.gateway));
  const prefix = `sdlc-tool-${runId}-`;
  const containers = await docker.containerList(runLabel).catch(() => []);
  for (const container of containers) {
    const name = (container.Names ?? [])
      .map((n) => n.replace(/^\//, ''))
      .find((n) => n.startsWith(prefix));
    if (name !== undefined) await attempt(() => docker.containerRemove(name));
  }
  await attempt(() => docker.networkRemove(names.toolNetwork));
  await attempt(() => docker.volumeRemove(names.gatewayConfig));
  if (firstError !== undefined) throw firstError;
}
