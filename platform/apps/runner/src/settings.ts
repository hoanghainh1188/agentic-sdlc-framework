// Runner settings (ADR-M25 §2.6). Deployment settings come from the environment, not from
// @sdlc/config: they describe this Docker host, not the handbook rules of a project. The sandbox
// image is the one exception that belongs to the project (config `sandbox.image`, QUESTIONS #59).
//
// Nothing here can loosen the sandbox hardening (ADR-M25 §2.4): the settings choose sizes and the
// services a sandbox may reach, never capabilities, mounts or the network type.
import { RunnerError } from './errors.js';

export const RUNNER_ENV = {
  dockerSocket: 'SDLC_RUNNER_DOCKER_SOCKET',
  instance: 'SDLC_RUNNER_INSTANCE',
  maxSandboxes: 'SDLC_RUNNER_MAX_SANDBOXES',
  memoryMb: 'SDLC_RUNNER_SANDBOX_MEMORY_MB',
  cpus: 'SDLC_RUNNER_SANDBOX_CPUS',
  pids: 'SDLC_RUNNER_SANDBOX_PIDS',
  tmpMb: 'SDLC_RUNNER_SANDBOX_TMP_MB',
  egressServices: 'SDLC_RUNNER_EGRESS_SERVICES',
  npmRegistry: 'SDLC_RUNNER_NPM_REGISTRY',
} as const;

/**
 * A service a sandbox may reach (D-03 §9 v1.6): LiteLLM or a package proxy. The runner attaches
 * `container` to the run's internal network under `alias`; the contract names it `alias:port`.
 */
export interface EgressService {
  readonly alias: string;
  readonly container: string;
  readonly port: number;
}

export interface SandboxLimits {
  readonly memoryBytes: number;
  /** Docker `NanoCpus` (1.5 CPUs = 1_500_000_000). */
  readonly nanoCpus: number;
  readonly pids: number;
  readonly tmpBytes: number;
}

export interface RunnerSettings {
  /** Path of the Docker Engine socket (in Compose: the socket proxy, ADR-M25 §2.5). */
  readonly dockerSocket: string;
  /** Label value that separates runner deployments sharing one Docker host. */
  readonly instance: string;
  /** Concurrent sandboxes (D-03 §10.1: 1–2 on the internal server). Extra runs wait. */
  readonly maxSandboxes: number;
  readonly limits: SandboxLimits;
  readonly egressServices: readonly EgressService[];
  /** npm registry URL given to the sandbox; its host must be an egress service alias. */
  readonly npmRegistry: string | undefined;
}

export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
export const DEFAULTS = {
  instance: 'sdlc',
  maxSandboxes: 1,
  memoryMb: 2048,
  cpus: '1.5',
  pids: 512,
  tmpMb: 512,
} as const;
/** More than this on one host is a mistake, not a setting (each sandbox reserves ~2 GiB). */
export const MAX_SANDBOXES_LIMIT = 16;

const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const ALIAS = /^[a-z][a-z0-9-]{0,62}$/;
const CPUS = /^(?:[0-9]{1,2})(?:\.[0-9]{1,2})?$/;
const MIB = 1024 * 1024;

function invalid(name: string): RunnerError {
  return new RunnerError('runner.config.invalid_setting', { name });
}

function intSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) throw invalid(name);
  const value = Number(raw);
  if (value < min || value > max) throw invalid(name);
  return value;
}

/** Parses `alias=container:port,alias=container:port`. */
export function parseEgressServices(raw: string | undefined): EgressService[] {
  if (raw === undefined || raw.trim() === '') return [];
  const services = raw.split(',').map((entry) => {
    const match = /^([^=]+)=([^:]+):([0-9]{1,5})$/.exec(entry.trim());
    const alias = match?.[1] ?? '';
    const container = match?.[2] ?? '';
    const port = Number(match?.[3]);
    if (!ALIAS.test(alias) || !NAME.test(container) || port < 1 || port > 65535) {
      throw invalid(RUNNER_ENV.egressServices);
    }
    return { alias, container, port };
  });
  const aliases = services.map((s) => s.alias);
  if (new Set(aliases).size !== aliases.length) throw invalid(RUNNER_ENV.egressServices);
  return services;
}

function npmRegistry(
  raw: string | undefined,
  services: readonly EgressService[],
): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(RUNNER_ENV.npmRegistry);
  }
  // Inside the sandbox the only reachable names are the egress aliases, on the internal network.
  const service = services.find((s) => s.alias === url.hostname);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    service?.port !== port
  ) {
    throw invalid(RUNNER_ENV.npmRegistry);
  }
  return url.toString();
}

/** Reads and checks the runner settings from environment variables. */
export function runnerSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): RunnerSettings {
  const dockerSocket = env[RUNNER_ENV.dockerSocket] || DEFAULT_DOCKER_SOCKET;
  if (!dockerSocket.startsWith('/')) throw invalid(RUNNER_ENV.dockerSocket);
  const instance = env[RUNNER_ENV.instance] || DEFAULTS.instance;
  if (!NAME.test(instance)) throw invalid(RUNNER_ENV.instance);
  const cpus = env[RUNNER_ENV.cpus] || DEFAULTS.cpus;
  if (!CPUS.test(cpus) || Number(cpus) <= 0) throw invalid(RUNNER_ENV.cpus);
  const egressServices = parseEgressServices(env[RUNNER_ENV.egressServices]);
  return {
    dockerSocket,
    instance,
    maxSandboxes: intSetting(
      env,
      RUNNER_ENV.maxSandboxes,
      DEFAULTS.maxSandboxes,
      1,
      MAX_SANDBOXES_LIMIT,
    ),
    limits: {
      memoryBytes: intSetting(env, RUNNER_ENV.memoryMb, DEFAULTS.memoryMb, 256, 65_536) * MIB,
      nanoCpus: Math.round(Number(cpus) * 1e9),
      pids: intSetting(env, RUNNER_ENV.pids, DEFAULTS.pids, 64, 32_768),
      tmpBytes: intSetting(env, RUNNER_ENV.tmpMb, DEFAULTS.tmpMb, 64, 16_384) * MIB,
    },
    egressServices,
    npmRegistry: npmRegistry(env[RUNNER_ENV.npmRegistry], egressServices),
  };
}
