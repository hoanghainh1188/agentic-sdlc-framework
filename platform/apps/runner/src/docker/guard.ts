// Guard for everything the runner asks Docker to create (ADR-M25 §2.5). The spec builder
// (sandbox/spec.ts) already produces a hardened container; the guard checks it again at the last
// point before the socket, so a later code change cannot weaken a sandbox by accident.
//
// Allowlist, not blocklist: a key that is not listed here is refused, so a new Docker option
// (privileged, host mounts, devices, host namespaces…) never slips through unnoticed.
import { RunnerError } from '../errors.js';
import { LABELS, MANAGED_BY } from '../names.js';

/** Environment variables a sandbox may receive (FR-33, ADR-M10 §2.4). Values are never secrets. */
export const SANDBOX_ENV_ALLOWLIST = [
  'SESSION_API_KEY', // random per run, authenticates the runner to the Agent Server
  'OH_SECRET_KEY', // random per run, encrypts the Agent Server's own state
  'OH_ENABLE_VSCODE',
  'OH_TELEMETRY_EXPORTER',
  'DO_NOT_TRACK',
  'OPENHANDS_SUPPRESS_BANNER',
  'NPM_CONFIG_REGISTRY', // the package proxy (QUESTIONS #59 C)
  'COREPACK_NPM_REGISTRY', // same proxy, so a project's `packageManager` pin can be fetched
] as const;

export const WORKSPACE_PATH = '/workspace';
export const SANDBOX_USER = '10001:10001';
/** tmpfs mounts of a sandbox. `/tmp` needs `exec` (ADR-M10 §2.4). */
export const TMPFS_PATHS = ['/tmp', '/home/openhands'] as const;

export interface ContainerSpec {
  readonly Image: string;
  readonly User: string;
  readonly Env: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly WorkingDir: string;
  readonly NetworkDisabled: false;
  readonly HostConfig: {
    readonly NetworkMode: string;
    readonly ReadonlyRootfs: true;
    readonly CapDrop: readonly ['ALL'];
    readonly SecurityOpt: readonly ['no-new-privileges:true'];
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly NanoCpus: number;
    readonly PidsLimit: number;
    readonly Tmpfs: Readonly<Record<string, string>>;
    readonly Mounts: readonly {
      readonly Type: 'volume';
      readonly Source: string;
      readonly Target: string;
      readonly ReadOnly: false;
    }[];
    readonly RestartPolicy: { readonly Name: 'no' };
    readonly AutoRemove: false;
    readonly Init: true;
  };
}

const TOP_KEYS = new Set([
  'Image',
  'User',
  'Env',
  'Labels',
  'WorkingDir',
  'NetworkDisabled',
  'HostConfig',
]);
const HOST_KEYS = new Set([
  'NetworkMode',
  'ReadonlyRootfs',
  'CapDrop',
  'SecurityOpt',
  'Memory',
  'MemorySwap',
  'NanoCpus',
  'PidsLimit',
  'Tmpfs',
  'Mounts',
  'RestartPolicy',
  'AutoRemove',
  'Init',
]);
const PINNED = /@sha256:[0-9a-f]{64}$/;
const SANDBOX_NAME = /^sdlc-sandbox-[0-9a-f-]{36}$/;
const RUN_NETWORK = /^sdlc-run-[0-9a-f-]{36}$/;
const RUN_VOLUME = /^sdlc-ws-[0-9a-f-]{36}$/;
const TMPFS_OPTIONS =
  /^(?:rw,)?(?:exec|noexec),nosuid,nodev,size=[0-9]+,mode=[0-7]{3,4}(?:,uid=10001,gid=10001)?$/;

function refuse(check: string): never {
  throw new RunnerError('runner.docker.spec_refused', { check });
}

function sameList(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i])
  );
}

function positiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Throws `runner.docker.spec_refused` unless the container is a hardened sandbox of one run. */
export function assertSafeContainerSpec(name: string, spec: ContainerSpec): void {
  const raw = spec as unknown as Record<string, unknown>;
  const host = (raw.HostConfig ?? {}) as Record<string, unknown>;
  if (!SANDBOX_NAME.test(name)) refuse('name');
  if (Object.keys(raw).some((key) => !TOP_KEYS.has(key))) refuse('unknown_option');
  if (Object.keys(host).some((key) => !HOST_KEYS.has(key))) refuse('unknown_host_option');
  if (typeof spec.Image !== 'string' || !PINNED.test(spec.Image)) refuse('image_not_pinned');
  if (spec.User !== SANDBOX_USER) refuse('user');
  if (spec.WorkingDir !== WORKSPACE_PATH) refuse('working_dir');
  if (spec.NetworkDisabled !== false) refuse('network_disabled');

  const env = Array.isArray(spec.Env) ? spec.Env : refuse('env');
  const names = env.map((entry) => (typeof entry === 'string' ? entry.split('=')[0] : ''));
  if (names.some((n) => !(SANDBOX_ENV_ALLOWLIST as readonly string[]).includes(n ?? ''))) {
    refuse('env');
  }
  if (new Set(names).size !== names.length) refuse('env');

  const labels = spec.Labels as Record<string, unknown> | undefined;
  if (labels?.[LABELS.managed] !== MANAGED_BY) refuse('labels');
  if (`sdlc-sandbox-${String(labels[LABELS.runId])}` !== name) refuse('labels');

  const hc = spec.HostConfig;
  if (
    !RUN_NETWORK.test(hc.NetworkMode) ||
    hc.NetworkMode !== `sdlc-run-${String(labels[LABELS.runId])}`
  ) {
    refuse('network');
  }
  if (hc.ReadonlyRootfs !== true) refuse('read_only');
  if (!sameList(hc.CapDrop, ['ALL'])) refuse('capabilities');
  if (!sameList(hc.SecurityOpt, ['no-new-privileges:true'])) refuse('security_opt');
  if (!positiveInt(hc.Memory) || hc.MemorySwap !== hc.Memory) refuse('memory');
  if (!positiveInt(hc.NanoCpus)) refuse('cpus');
  if (!positiveInt(hc.PidsLimit)) refuse('pids');
  if (hc.RestartPolicy?.Name !== 'no' || hc.AutoRemove !== false || hc.Init !== true) {
    refuse('lifecycle');
  }

  const tmpfs = Object.entries(hc.Tmpfs ?? {});
  if (
    !sameList(
      tmpfs.map(([path]) => path),
      TMPFS_PATHS,
    ) ||
    tmpfs.some(([, options]) => !TMPFS_OPTIONS.test(options))
  ) {
    refuse('tmpfs');
  }

  // The only mount: the run's own workspace volume. Never a bind mount, never the Docker socket.
  const mounts: readonly unknown[] = Array.isArray(hc.Mounts)
    ? (hc.Mounts as readonly unknown[])
    : refuse('mounts');
  const mount = (mounts[0] ?? {}) as Readonly<Record<string, unknown>>;
  const workspaceVolume = `sdlc-ws-${String(labels[LABELS.runId])}`;
  if (
    mounts.length !== 1 ||
    mount.Type !== 'volume' ||
    mount.Source !== workspaceVolume ||
    !RUN_VOLUME.test(workspaceVolume) ||
    mount.Target !== WORKSPACE_PATH ||
    mount.ReadOnly !== false ||
    Object.keys(mount).length !== 4
  ) {
    refuse('mounts');
  }
}

/** Throws unless the network is a run's own internal bridge (no route out, ADR-M25 §2.2). */
export function assertSafeNetworkSpec(spec: {
  readonly Name: string;
  readonly Driver: string;
  readonly Internal: boolean;
  readonly Attachable: boolean;
  readonly EnableIPv6: boolean;
  readonly Labels: Readonly<Record<string, string>>;
  readonly Options: Readonly<Record<string, string>>;
}): void {
  const allowed = new Set([
    'Name',
    'Driver',
    'Internal',
    'Attachable',
    'EnableIPv6',
    'Labels',
    'Options',
  ]);
  if (Object.keys(spec).some((key) => !allowed.has(key))) refuse('unknown_network_option');
  if (!RUN_NETWORK.test(spec.Name)) refuse('network_name');
  if (spec.Driver !== 'bridge' || spec.Internal !== true) refuse('network_internal');
  if (spec.Attachable !== false || spec.EnableIPv6 !== false) refuse('network_options');
  if (spec.Labels[LABELS.managed] !== MANAGED_BY) refuse('labels');
  if (`sdlc-run-${String(spec.Labels[LABELS.runId])}` !== spec.Name) refuse('labels');
  // Exactly one option: no IP address for the bridge, so the host is not reachable (ADR-M25 §2.2).
  const options = Object.entries(spec.Options);
  if (
    options.length !== 1 ||
    options[0]?.[0] !== 'com.docker.network.bridge.inhibit_ipv4' ||
    options[0][1] !== 'true'
  ) {
    refuse('network_options');
  }
}
