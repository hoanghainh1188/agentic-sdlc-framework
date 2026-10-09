// The settings file of the trial stack (README "Fresh deployment" step 2): the file
// `init-env.sh` writes, with the trial's own Compose project, and in server mode for LiteLLM
// (its master and salt keys come from OpenBao through the profile `models`, not from the file).
// Pure.

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

export function trialEnv(text: string, override?: ProjectOverride): string {
  let out = set(text, 'COMPOSE_PROJECT_NAME', override?.project ?? TRIAL_PROJECT);
  out = set(out, 'LITELLM_MASTER_KEY', '');
  out = set(out, 'LITELLM_SALT_KEY', '');
  if (override) {
    out = set(out, 'SDLC_NETWORK_SUBNET', override.subnet);
    out = set(out, 'SDLC_NETWORK_GATEWAY', override.gateway);
    out = out.replace(
      /^(\w+_HOST_PORT)=(\d+)$/gm,
      (_, key: string, port: string) => `${key}=${Number(port) + override.portOffset}`,
    );
  }
  return out;
}

/** One value of an env file, or undefined. */
export function envValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  return m?.[1];
}

/** The host port of a service in the env file (`SDLC_API_HOST_PORT` …), or its default. */
export function hostPort(text: string, key: string, fallback: number): number {
  const value = Number(envValue(text, key));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
