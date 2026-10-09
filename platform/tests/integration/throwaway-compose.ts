// Helpers for the live tests that start a throw-away Compose project (tasks A02, A03, A04, A11).
// Since A11, OpenBao publishes no port on the host (design/QUESTIONS.md #27): the tests reach it
// through a one-shot container on the throw-away Compose network, like a platform process.
// Since A10 (design/ADR-M63), OpenBao speaks TLS on 8200: a one-shot container mounts the CA of
// the project's volume openbao-ca and verifies the certificate, like the platform processes.
import { spawnSync } from 'node:child_process';

import { loadCompose } from '../deploy/compose';

export interface ThrowawayProject {
  /** Compose project name; the network is `<project>-net`. */
  readonly project: string;
  /** Own subnet: two Compose networks cannot share one. */
  readonly subnet: string;
  /** Gateway of the subnet (SDLC_NETWORK_GATEWAY), left out of the OpenBao AppRole CIDRs. */
  readonly gateway: string;
  /** Added to every *_HOST_PORT, so a developer's running stack is never touched. */
  readonly portOffset: number;
}

/** The env file text with the project name, subnet, gateway and host ports of `p`. */
export function isolateEnv(text: string, p: ThrowawayProject): string {
  const set = (input: string, key: string, value: string): string => {
    const line = new RegExp(`^${key}=.*$`, 'm');
    if (!line.test(input)) throw new Error(`${key} is missing in the env file`);
    return input.replace(line, `${key}=${value}`);
  };
  let out = set(text, 'COMPOSE_PROJECT_NAME', p.project);
  out = set(out, 'SDLC_NETWORK_SUBNET', p.subnet);
  out = set(out, 'SDLC_NETWORK_GATEWAY', p.gateway);
  return out.replace(
    /^(\w+_HOST_PORT)=(\d+)$/gm,
    (_, key: string, port: string) => `${key}=${Number(port) + p.portOffset}`,
  );
}

/** The pinned OpenBao image of platform/deploy/docker-compose.yml. */
export function openbaoImage(): string {
  const image = loadCompose().services.openbao?.image;
  if (!image) throw new Error('openbao has no image in docker-compose.yml');
  return image;
}

/** Where a one-shot container mounts OpenBao's CA certificate (as the platform processes do). */
export const OPENBAO_CA_FILE = '/run/sdlc/openbao-ca/ca.pem';
export const OPENBAO_URL = 'https://openbao:8200';

/** The Compose project of a throw-away network `<project>-net`. */
function projectOf(network: string): string {
  if (!network.endsWith('-net')) throw new Error(`not a Compose network: ${network}`);
  return network.slice(0, -'-net'.length);
}

/** `docker run` options that mount the project's CA read-only (volume `<project>_openbao-ca`). */
export function openbaoCaMount(network: string): string[] {
  return ['-v', `${projectOf(network)}_openbao-ca:/run/sdlc/openbao-ca:ro`];
}

/** `docker run` options for a `bao` command against OpenBao over TLS, CA verified. */
export function baoClientArgs(network: string): string[] {
  return [
    ...openbaoCaMount(network),
    '-e',
    `BAO_ADDR=${OPENBAO_URL}`,
    '-e',
    `BAO_CACERT=${OPENBAO_CA_FILE}`,
  ];
}

export interface SealStatus {
  initialized: boolean;
  sealed: boolean;
  t: number;
  n: number;
  progress: number;
}

/**
 * Reads the seal status from a one-shot container on `network` (no host port since A11), over TLS.
 * Retries briefly: right after a restart OpenBao can refuse connections.
 */
export async function sealStatusOnNetwork(network: string): Promise<SealStatus> {
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        network,
        ...baoClientArgs(network),
        '--entrypoint',
        'bao',
        openbaoImage(),
        'status',
        '-format=json',
      ],
      { encoding: 'utf8' },
    );
    // `bao status`: 0 unsealed, 2 sealed or uninitialised (both print the status), 1 an error.
    if ((r.status === 0 || r.status === 2) && r.stdout.trim().startsWith('{'))
      return JSON.parse(r.stdout) as SealStatus;
    if (attempt >= 20) throw new Error(`seal-status failed: ${r.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Gateway addresses of a Docker network, as Docker reports them. */
export function networkGateways(network: string): string[] {
  const r = spawnSync(
    'docker',
    ['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Gateway}} {{end}}', network],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`docker network inspect failed: ${r.stderr}`);
  return r.stdout.trim().split(/\s+/).filter(Boolean);
}

/** Host port bindings of a container, e.g. { "8200/tcp": null } when nothing is published. */
export function hostPortBindings(container: string): Record<string, unknown> {
  const r = spawnSync('docker', ['inspect', '-f', '{{json .NetworkSettings.Ports}}', container], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`docker inspect failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/** IP address of a container on `network`. */
export function containerIp(container: string, network: string): string {
  const r = spawnSync(
    'docker',
    ['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container],
    { encoding: 'utf8' },
  );
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`no IP on ${network}: ${r.stderr}`);
  return r.stdout.trim();
}
