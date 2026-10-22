// Container specs of a run's register tools and MCP gateway (task X04, design/ADR-M69 §2.4,
// ADR-M87 §5). The guard (docker/guard.ts) checks each again before Docker sees it.
import crypto from 'node:crypto';

import {
  GATEWAY_COMMAND,
  GATEWAY_CONFIG_DIR,
  GATEWAY_USER,
  TOOL_LOG_CONFIG,
  TOOL_TMPFS_PATH,
  TOOL_USER,
  type ToolContainerSpec,
} from '../docker/guard.js';
import type { ToolObjectNames } from '../names.js';

/** Limits of one container, from project configuration `tools.container_limits`. */
export interface ToolLimits {
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pids: number;
}

/** The gateway's own limits: about 10 MiB idle, under 1 ms per call (ADR-M87 §3.3). */
export const GATEWAY_LIMITS: ToolLimits = {
  memoryBytes: 128 * 1024 * 1024,
  nanoCpus: 500_000_000,
  pids: 256,
};

/** `/tmp` of a tool container: never executable, 64 MiB. */
const TOOL_TMPFS = 'rw,noexec,nosuid,nodev,size=67108864,mode=1777';

function hardened(
  network: string,
  limits: ToolLimits,
): Omit<ToolContainerSpec['HostConfig'], 'Tmpfs' | 'Mounts'> {
  return {
    NetworkMode: network,
    LogConfig: { Type: 'json-file', Config: TOOL_LOG_CONFIG },
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    Memory: limits.memoryBytes,
    MemorySwap: limits.memoryBytes,
    NanoCpus: limits.nanoCpus,
    PidsLimit: limits.pids,
    RestartPolicy: { Name: 'no' },
    AutoRemove: false,
    Init: true,
  };
}

/**
 * The host the gateway calls for a tool: a short alias on the tool network, from the tool key. A
 * container name with a long key would not fit in a DNS label (63 characters).
 */
export function toolHost(toolKey: string): string {
  return `t-${crypto.createHash('sha256').update(toolKey, 'utf8').digest('hex').slice(0, 12)}`;
}

/** A tool container: its image by digest and its own command, on the tool network only. */
export function buildToolSpec(input: {
  readonly names: ToolObjectNames;
  readonly labels: Readonly<Record<string, string>>;
  readonly toolKey: string;
  /** `<image_ref>@sha256:…` from the register and the contract's grant. */
  readonly image: string;
  readonly limits: ToolLimits;
}): ToolContainerSpec {
  return {
    Image: input.image,
    User: TOOL_USER,
    Env: [],
    Labels: input.labels,
    NetworkDisabled: false,
    NetworkingConfig: {
      EndpointsConfig: { [input.names.toolNetwork]: { Aliases: [toolHost(input.toolKey)] } },
    },
    HostConfig: {
      ...hardened(input.names.toolNetwork, input.limits),
      Tmpfs: { [TOOL_TMPFS_PATH]: TOOL_TMPFS },
      Mounts: [],
    },
  };
}

/** The gateway: its image by digest, its one command, the run's config volume. */
export function buildGatewaySpec(input: {
  readonly names: ToolObjectNames;
  readonly labels: Readonly<Record<string, string>>;
  readonly image: string;
}): ToolContainerSpec {
  return {
    Image: input.image,
    User: GATEWAY_USER,
    Env: [],
    Labels: input.labels,
    Cmd: GATEWAY_COMMAND,
    NetworkDisabled: false,
    HostConfig: {
      ...hardened(input.names.toolNetwork, GATEWAY_LIMITS),
      Tmpfs: {},
      Mounts: [
        {
          Type: 'volume',
          Source: input.names.gatewayConfig,
          Target: GATEWAY_CONFIG_DIR,
          ReadOnly: false,
        },
      ],
    },
  };
}
