// Names and labels of the Docker objects of one run (ADR-M25 §2.3). Every name is built from the
// run ID, which must be a lowercase UUID, so nothing from a contract reaches Docker unchecked.
import { RunnerError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Label keys set on every container, network and volume the runner creates. */
export const LABELS = {
  managed: 'sdlc.managed-by',
  instance: 'sdlc.runner-instance',
  runId: 'sdlc.run-id',
  tenantId: 'sdlc.tenant-id',
} as const;

export const MANAGED_BY = 'sdlc-runner';

export interface RunNames {
  readonly runId: string;
  readonly container: string;
  readonly network: string;
  readonly volume: string;
}

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Docker object names of one run. Throws for anything but a lowercase UUID. */
export function runNames(runId: string): RunNames {
  if (!isRunId(runId)) throw new RunnerError('runner.invalid_run_id');
  return {
    runId,
    container: `sdlc-sandbox-${runId}`,
    network: `sdlc-run-${runId}`,
    volume: `sdlc-ws-${runId}`,
  };
}

/** Docker objects of one run's register tools (X04, ADR-M69 §2.4, ADR-M87 §5). */
export interface ToolObjectNames {
  /** The run's MCP gateway: on the tool network, and on the run network under `tools`. */
  readonly gateway: string;
  /** The internal network of the gateway and the tool containers; the sandbox is not on it. */
  readonly toolNetwork: string;
  /** The volume that holds the gateway's configuration file. */
  readonly gatewayConfig: string;
  /** The container of one tool; the gateway reaches it by this name on the tool network. */
  tool(toolKey: string): string;
  /**
   * X04 PR 3b (ADR-M69 §2.4, QUESTIONS #531): the service network of one tool with backing
   * services: that tool and its services only (never the gateway, the sandbox or another tool).
   */
  serviceNetwork(toolKey: string): string;
  /** X04 PR 3b: the volume with the tool's `config.json` and `credentials.json`. */
  toolRuntime(toolKey: string): string;
}

const TOOL_KEY = /^[a-z][a-z0-9-]{1,62}$/;

/** Names of a run's tool objects. Throws for anything but a lowercase UUID or a tool key. */
export function toolObjectNames(runId: string): ToolObjectNames {
  if (!isRunId(runId)) throw new RunnerError('runner.invalid_run_id');
  return {
    gateway: `sdlc-gw-${runId}`,
    toolNetwork: `sdlc-tool-${runId}`,
    gatewayConfig: `sdlc-gwcfg-${runId}`,
    tool(toolKey: string): string {
      if (!TOOL_KEY.test(toolKey)) throw new RunnerError('runner.invalid_run_id');
      return `sdlc-tool-${runId}-${toolKey}`;
    },
    serviceNetwork(toolKey: string): string {
      if (!TOOL_KEY.test(toolKey)) throw new RunnerError('runner.invalid_run_id');
      return `sdlc-toolsvc-${runId}-${toolKey}`;
    },
    toolRuntime(toolKey: string): string {
      if (!TOOL_KEY.test(toolKey)) throw new RunnerError('runner.invalid_run_id');
      return `sdlc-toolrt-${runId}-${toolKey}`;
    },
  };
}

/** Labels of one run's objects. `instance` separates runner deployments on one Docker host. */
export function runLabels(
  instance: string,
  runId: string,
  tenantId: string,
): Readonly<Record<string, string>> {
  if (!isRunId(runId) || !isRunId(tenantId)) throw new RunnerError('runner.invalid_run_id');
  return {
    [LABELS.managed]: MANAGED_BY,
    [LABELS.instance]: instance,
    [LABELS.runId]: runId,
    [LABELS.tenantId]: tenantId,
  };
}

/** Run and tenant of a Docker object, read back from its labels. */
export interface LabelledRun {
  readonly runId: string;
  readonly tenantId: string;
}

/**
 * Reads the run of a Docker object from its labels, for the clean-up after a restart and the
 * sweep (ADR-M25 §2.8). The `sdlc.*` labels count only on an object that the runner manages and
 * that carries **this** runner's instance label; anything else returns undefined and is left alone.
 */
export function runOfLabels(
  labels: Readonly<Record<string, string>> | null | undefined,
  instance: string,
): LabelledRun | undefined {
  if (!labels) return undefined;
  if (labels[LABELS.managed] !== MANAGED_BY || labels[LABELS.instance] !== instance) {
    return undefined;
  }
  const runId = labels[LABELS.runId];
  const tenantId = labels[LABELS.tenantId];
  if (!isRunId(runId) || !isRunId(tenantId)) return undefined;
  return { runId, tenantId };
}
