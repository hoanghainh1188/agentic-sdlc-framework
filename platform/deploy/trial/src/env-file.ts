// The settings file of the trial stack (README "Fresh deployment" step 2): the file
// `init-env.sh` writes, with the trial's own Compose project, and in server mode for LiteLLM
// (its master and salt keys come from OpenBao through the profile `models`, not from the file).
// Pure.
import { envSecrets, envValue, hostPort } from '../../steps/dist/env-file.js';

export { envSecrets, envValue, hostPort };

/** The trial's own Compose project: its volumes are `sdlc-trial_*`, never the dev stack's `sdlc_*`. */
export const TRIAL_PROJECT = 'sdlc-trial';

/** A throw-away project of the live test: another name, network and host ports. */
export interface ProjectOverride {
  readonly project: string;
  readonly subnet: string;
  readonly gateway: string;
  readonly portOffset: number;
}

function set(text: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, 'm');
  if (!line.test(text)) throw new Error(`${key} is missing in the env file`);
  return text.replace(line, `${key}=${value}`);
}

/** The settings of the network `access` (V09, design/ADR-M67 §2.5) of a throw-away project. */
export interface AccessNetwork {
  readonly subnet: string;
  readonly ipRange: string;
  readonly proxyIp: string;
}

/**
 * A throw-away project's own network `access`, derived from its `sdlc` subnet `172.B.C.0/24`
 * (B 29-31), so two projects never share one: a /29 in 172.28.0.0/16, never used by a project's
 * `sdlc` subnet. The api always joins `access` (ADR-M67 §2.5), so every throw-away project with
 * sdlc-api needs its own. Pure.
 */
export function accessNetworkFor(subnet: string): AccessNetwork {
  const m = /^172\.(29|30|31)\.(\d{1,3})\.0\/24$/.exec(subnet);
  const third = Number(m?.[2] ?? NaN);
  if (!m || third > 255) throw new Error(`not a throw-away subnet 172.29-31.x.0/24: ${subnet}`);
  const index = (Number(m[1]) - 29) * 256 + third;
  const base = index * 8;
  const prefix = `172.28.${Math.floor(base / 256)}`;
  const last = base % 256;
  return {
    subnet: `${prefix}.${last}/29`,
    ipRange: `${prefix}.${last}/30`,
    proxyIp: `${prefix}.${last + 6}`,
  };
}

export function trialEnv(text: string, override?: ProjectOverride): string {
  let out = set(text, 'COMPOSE_PROJECT_NAME', override?.project ?? TRIAL_PROJECT);
  out = set(out, 'LITELLM_MASTER_KEY', '');
  out = set(out, 'LITELLM_SALT_KEY', '');
  if (override) {
    out = set(out, 'SDLC_NETWORK_SUBNET', override.subnet);
    out = set(out, 'SDLC_NETWORK_GATEWAY', override.gateway);
    const access = accessNetworkFor(override.subnet);
    out = set(out, 'SDLC_ACCESS_NETWORK_SUBNET', access.subnet);
    out = set(out, 'SDLC_ACCESS_NETWORK_IP_RANGE', access.ipRange);
    out = set(out, 'SDLC_ACCESS_PROXY_IP', access.proxyIp);
    out = out.replace(
      /^(\w+_HOST_PORT)=(\d+)$/gm,
      (_, key: string, port: string) => `${key}=${Number(port) + override.portOffset}`,
    );
  }
  return out;
}

/** The API address of the trial stack, as `trial:up` writes it into the logins. */
export function trialApiUrl(text: string): string {
  return `http://127.0.0.1:${hostPort(text, 'SDLC_API_HOST_PORT', 8090)}`;
}
