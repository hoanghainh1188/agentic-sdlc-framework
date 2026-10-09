// What `pnpm trial:up` refuses before it touches anything (D-08 V02 AC2). Pure: `host.ts` gathers
// the facts, this module decides. Every refusal is a catalog key with parameters (NFR-08).
import type { MessageKey } from '@sdlc/messages';

import { MODEL_NAMES, type TrialSettings } from './settings.js';

const GIB = 1024 ** 3;
/** Docker's own memory (the VM on Docker Desktop): the platform (~3 GB) and one sandbox (2 GB). */
export const MIN_DOCKER_MEMORY_GIB = 8;
/** The machine's memory (TRIAL.md §1): an API model, or the local model's ~14 GB more. */
export const MIN_HOST_MEMORY_GIB: Readonly<Record<'ollama' | 'anthropic', number>> = {
  anthropic: 16,
  ollama: 32,
};
/** `docker compose` 2.24 or later (platform/deploy/README.md, Requirements). */
const MIN_COMPOSE: readonly [number, number] = [2, 24];
/** The Ollama tag behind the gateway name `gpt-oss-20b` (never a `:cloud` model). */
export const OLLAMA_TAG = 'gpt-oss:20b';

export interface FileFact {
  readonly path: string;
  /** `null`: missing or unreadable. */
  readonly mode: number | null;
}

export interface HostFacts {
  readonly nodeEnv: string | undefined;
  readonly envFile: string;
  readonly envFileExists: boolean;
  /** Volumes of the dev stack (`sdlc_*`) or of an earlier trial stack. */
  readonly existingVolumes: readonly string[];
  /** `null`: no Docker, or the daemon does not answer. */
  readonly docker: { readonly composeVersion: string | null; readonly memoryBytes: number } | null;
  readonly hostMemoryBytes: number;
  /** Local Ollama tags, or `null` when Ollama does not answer (only asked for the local model). */
  readonly ollamaTags: readonly string[] | null | undefined;
  readonly secretFiles: readonly FileFact[];
  /** The fork's clone has `AGENTS.md` on its `main` branch. */
  readonly forkInstructions: boolean;
  readonly existingCredentials: readonly string[];
}

export interface Refusal {
  readonly key: MessageKey;
  readonly params: Readonly<Record<string, string | number>>;
}

function composeTooOld(version: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major < MIN_COMPOSE[0] || (major === MIN_COMPOSE[0] && minor < MIN_COMPOSE[1]);
}

/** Every reason not to start, in a fixed order. Empty: go ahead. */
export function preflight(settings: TrialSettings, facts: HostFacts): Refusal[] {
  const out: Refusal[] = [];
  const no = (key: MessageKey, params: Refusal['params'] = {}) => out.push({ key, params });

  if (facts.nodeEnv === 'production') no('trial.refused.production');
  if (facts.envFileExists) no('trial.refused.env_exists', { path: facts.envFile });
  if (facts.existingVolumes.length > 0) {
    no('trial.refused.volumes_exist', {
      count: facts.existingVolumes.length,
      first: facts.existingVolumes[0]!,
    });
  }
  if (facts.docker === null) {
    no('trial.refused.no_docker');
  } else {
    if (facts.docker.composeVersion === null || composeTooOld(facts.docker.composeVersion)) {
      no('trial.refused.compose_old', { version: facts.docker.composeVersion ?? '-' });
    }
    if (facts.docker.memoryBytes < MIN_DOCKER_MEMORY_GIB * GIB) {
      no('trial.refused.docker_memory', {
        have: Math.floor(facts.docker.memoryBytes / GIB),
        need: MIN_DOCKER_MEMORY_GIB,
      });
    }
  }
  const hostNeed = MIN_HOST_MEMORY_GIB[settings.model.provider];
  // Machines sold as "16 GB" report a little less: allow 5 %.
  if (facts.hostMemoryBytes < hostNeed * GIB * 0.95) {
    no('trial.refused.host_memory', {
      have: Math.floor(facts.hostMemoryBytes / GIB),
      need: hostNeed,
      model: MODEL_NAMES[settings.model.provider],
    });
  }
  if (settings.model.provider === 'ollama') {
    if (facts.ollamaTags === null || facts.ollamaTags === undefined) {
      no('trial.refused.ollama_unreachable');
    } else if (!facts.ollamaTags.includes(OLLAMA_TAG)) {
      no('trial.refused.ollama_model_missing', { tag: OLLAMA_TAG });
    }
  }
  for (const file of facts.secretFiles) {
    if (file.mode === null) no('trial.refused.file_missing', { path: file.path });
    else if ((file.mode & 0o077) !== 0) {
      no('trial.refused.file_mode', { path: file.path, mode: (file.mode & 0o777).toString(8) });
    }
  }
  if (!facts.forkInstructions) no('trial.refused.fork_instructions', { path: settings.forkClone });
  for (const file of facts.existingCredentials)
    no('trial.refused.credentials_exist', { path: file });
  return out;
}
