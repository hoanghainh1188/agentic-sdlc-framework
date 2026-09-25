// Sandbox containers for the C01 spike (de-risks C04). Uses the Docker CLI through execFile, so the
// spike adds no dependency. C04 decides on the Docker API client for the real runner.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Pinned image (design/ADR-M10): tag for readers, digest for the supply chain. */
export const AGENT_SERVER_IMAGE =
  'ghcr.io/openhands/agent-server:1.48.0-python-slim@sha256:8fcfab2dedb4b41b6aef219b9fa9b1f2588033fad3d998ae6aa11fe8c4fcf8b7';
export const RELAY_IMAGE =
  'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
export const AGENT_SERVER_PORT = 8000;
/** Internal Docker network from compose.poc.yaml: no route out, only LiteLLM and the stub model. */
export const SANDBOX_NETWORK = 'sdlc-poc-sandbox';
export const SANDBOX_UID = 10001;

/** Only these variables may reach the sandbox. Nothing else from the host environment is passed. */
export const SANDBOX_ENV_ALLOWLIST = [
  'SESSION_API_KEY',
  'OH_SECRET_KEY',
  'OH_ENABLE_VSCODE',
  'OH_PRELOAD_TOOLS',
  'OH_TELEMETRY_EXPORTER',
  'DO_NOT_TRACK',
  'OPENHANDS_SUPPRESS_BANNER',
] as const;

export type SandboxEnvName = (typeof SANDBOX_ENV_ALLOWLIST)[number];

/** Spike defaults for C04 (deployment settings, not handbook rules). */
export interface SandboxLimits {
  memory: string;
  cpus: string;
  pids: number;
  workspaceSize: string;
  tmpSize: string;
}

export const POC_SANDBOX_LIMITS: SandboxLimits = {
  memory: '2g',
  cpus: '1.5',
  pids: 512,
  workspaceSize: '512m',
  tmpSize: '512m',
};

export interface SandboxOptions {
  name: string;
  runId: string;
  env: Partial<Record<SandboxEnvName, string>>;
  limits: SandboxLimits;
  readOnlyRoot: boolean;
}

/** Arguments for `docker run`. Pure, so tests can check every hardening flag. */
export function buildSandboxRunArgs(options: SandboxOptions): string[] {
  const { limits } = options;
  const args = [
    'run',
    '--detach',
    '--name',
    options.name,
    '--label',
    `sdlc.poc=c01`,
    '--label',
    `sdlc.run_id=${options.runId}`,
    '--network',
    SANDBOX_NETWORK,
    '--user',
    `${SANDBOX_UID}:${SANDBOX_UID}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--memory',
    limits.memory,
    '--memory-swap',
    limits.memory,
    '--cpus',
    limits.cpus,
    '--pids-limit',
    String(limits.pids),
  ];
  if (options.readOnlyRoot) {
    // /tmp needs `exec`: the image is a PyInstaller binary that unpacks shared libraries there.
    args.push(
      '--read-only',
      '--tmpfs',
      `/tmp:rw,exec,nosuid,nodev,size=${limits.tmpSize}`,
      '--tmpfs',
      `/workspace:rw,nosuid,nodev,size=${limits.workspaceSize},uid=${SANDBOX_UID},gid=${SANDBOX_UID}`,
      '--tmpfs',
      `/home/openhands:rw,nosuid,nodev,size=256m,uid=${SANDBOX_UID},gid=${SANDBOX_UID}`,
    );
  }
  for (const [key, value] of Object.entries(options.env)) {
    if (!(SANDBOX_ENV_ALLOWLIST as readonly string[]).includes(key)) {
      throw new Error(`environment variable ${key} is not allowed in the sandbox`);
    }
    if (value !== undefined) args.push('--env', `${key}=${value}`);
  }
  args.push(AGENT_SERVER_IMAGE);
  return args;
}

/**
 * Arguments for the relay container: the only way to reach a container that sits on an internal
 * network from the host (Docker publishes no ports there). It publishes the API port on 127.0.0.1
 * and forwards to the sandbox. The sandbox itself stays on the internal network only.
 */
export function buildRelayRunArgs(name: string, sandboxName: string, srcDir: string): string[] {
  return [
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    'sdlc.poc=c01',
    '--user',
    'node',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--publish',
    `127.0.0.1::${AGENT_SERVER_PORT}`,
    '--volume',
    `${srcDir}:/app/src:ro`,
    '--env',
    `RELAY_TARGET=${sandboxName}:${AGENT_SERVER_PORT}`,
    RELAY_IMAGE,
    'node',
    '/app/src/tcp-relay.ts',
  ];
}

export async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await run('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function startSandbox(options: SandboxOptions): Promise<void> {
  await docker(buildSandboxRunArgs(options));
}

/** Starts the relay and returns the host port that forwards to the sandbox API. */
export async function startRelay(
  name: string,
  sandboxName: string,
  srcDir: string,
): Promise<number> {
  await docker(buildRelayRunArgs(name, sandboxName, srcDir));
  await docker(['network', 'connect', SANDBOX_NETWORK, name]);
  const mapping = await docker(['port', name, `${AGENT_SERVER_PORT}/tcp`]);
  const port = Number(mapping.split('\n')[0]?.split(':').at(-1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`relay published no port: ${mapping}`);
  return port;
}

/** Kill switch: removes the container at once (SIGKILL), with its tmpfs workspace. */
export async function removeContainer(name: string): Promise<void> {
  await docker(['rm', '--force', '--volumes', name]).catch(() => undefined);
}

export async function inspect(name: string): Promise<Record<string, unknown>> {
  const [first] = JSON.parse(await docker(['inspect', name])) as Record<string, unknown>[];
  if (!first) throw new Error(`no container ${name}`);
  return first;
}

export async function containerExists(name: string): Promise<boolean> {
  const out = await docker(['ps', '--all', '--quiet', '--filter', `name=^${name}$`]);
  return out.length > 0;
}

export interface ResourceSample {
  memoryBytes: number;
  cpuPercent: number;
}

/** One `docker stats` sample. Memory is parsed from "123.4MiB / 2GiB". */
export function parseStats(line: string): ResourceSample {
  const [mem = '', cpu = ''] = line.split('|');
  const match = /^([\d.]+)\s*([KMG]i?B|B)/.exec(mem.trim());
  const units: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  const memoryBytes = match ? Number(match[1]) * (units[match[2] ?? 'B'] ?? 1) : NaN;
  return { memoryBytes, cpuPercent: Number(cpu.replace(/%/g, '').trim()) };
}

export async function sampleStats(name: string): Promise<ResourceSample> {
  return parseStats(
    await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', name]),
  );
}

export interface ListeningSocket {
  address: string;
  port: number;
  uid: number;
}

/**
 * Parses /proc/net/tcp and /proc/net/tcp6 (the image has no `ss` or `netstat`).
 * Keeps sockets in state 0A (LISTEN) only.
 */
export function parseProcNetTcp(text: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8 || cols[3] !== '0A') continue;
    const [addrHex = '', portHex = ''] = (cols[1] ?? '').split(':');
    sockets.push({
      address: hexToAddress(addrHex),
      port: parseInt(portHex, 16),
      uid: Number(cols[7]),
    });
  }
  return sockets;
}

function hexToAddress(hex: string): string {
  if (hex.length === 8) {
    // IPv4, little-endian.
    return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
  }
  return /^0+$/.test(hex) ? '::' : `ipv6:${hex}`;
}

export async function listeningSockets(name: string): Promise<ListeningSocket[]> {
  const text = await docker(['exec', name, 'cat', '/proc/net/tcp', '/proc/net/tcp6']);
  return parseProcNetTcp(text);
}

/** Environment of the running container as KEY=VALUE strings (for the FR-33 check). */
export function containerEnv(inspection: Record<string, unknown>): string[] {
  const config = inspection['Config'] as { Env?: string[] } | undefined;
  return config?.Env ?? [];
}
