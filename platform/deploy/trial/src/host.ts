// The real machine for `trial:up` and `trial:down`: child processes (output captured, never
// inherited), the `adlc` command in this process, and the facts `preflight` decides on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { processApiIo, processContext, runCli, type CliContext } from '@sdlc/cli';

import { exec } from '../../steps/dist/exec.js';

import { keyFileFor } from './keys.js';
import { OLLAMA_TAG, type FileFact, type HostFacts } from './preflight.js';
import { credentialsFiles, secretFiles, type TrialSettings } from './settings.js';
import type { Sdlc } from './up.js';

export { exec };

/**
 * One `adlc …` command in this process. The environment is only what the call names (an API URL
 * and token, a database URL, a config folder), so no saved login of the machine's user is used;
 * a token goes in through memory, never through `process.env` or a command line.
 */
export const sdlc: Sdlc = async (argv, env, stdin) => {
  const out: string[] = [];
  const err: string[] = [];
  const base = processContext();
  const io = processApiIo();
  const ctx: CliContext = {
    ...base,
    env: { PATH: process.env.PATH, HOME: os.homedir(), ...env },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    api:
      stdin === undefined
        ? io
        : { ...io, stdinIsTTY: false, readStdin: () => Promise.resolve(stdin) },
  };
  const status = await runCli(argv, ctx);
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
};

function fileFact(file: string): FileFact {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return { path: file, mode: fs.statSync(file).mode };
  } catch {
    return { path: file, mode: null };
  }
}

async function dockerFacts(): Promise<HostFacts['docker']> {
  const info = await exec('docker', ['info', '--format', '{{.MemTotal}}']);
  if (info.status !== 0) return null;
  const compose = await exec('docker', ['compose', 'version', '--short']);
  return {
    composeVersion: compose.status === 0 ? compose.stdout.trim() : null,
    memoryBytes: Number(info.stdout.trim()) || 0,
  };
}

/**
 * Volumes of the dev stack (`sdlc_…`) or of a trial stack (`<project>_…`). The live test's
 * throw-away project (other name, network and ports) checks only its own.
 */
async function volumes(project: string, devStack: boolean): Promise<string[] | null> {
  const r = await exec('docker', ['volume', 'ls', '-q']);
  // Unknown is never "none": preflight refuses (review V02 #2).
  if (r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .map((v) => v.trim())
    .filter((v) => (devStack && v.startsWith('sdlc_')) || v.startsWith(`${project}_`));
}

async function ollamaTags(url: string): Promise<string[] | null> {
  // The trial stack reaches Ollama through Docker's host name; this process runs on the host.
  const local = url.replace('host.docker.internal', '127.0.0.1');
  try {
    const res = await fetch(`${local}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: { name?: string }[] };
    return (body.models ?? []).map((m) => m.name ?? '').filter((n) => n !== '');
  } catch {
    return null;
  }
}

/**
 * Whether Git ignores a file: `true` or `false` inside a repository, `null` outside one (V08: the
 * key file must never be committed).
 */
async function gitIgnored(file: string): Promise<boolean | null> {
  const dir = path.dirname(file);
  const inside = await exec('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  const r = await exec('git', ['-C', dir, 'check-ignore', '-q', path.basename(file)]);
  return r.status === 0;
}

export async function gatherFacts(
  settings: TrialSettings,
  envFile: string,
  composeProject: string,
  devStack: boolean,
): Promise<HostFacts> {
  const docker = await dockerFacts();
  const forkInstructions =
    (await exec('git', ['-C', settings.forkClone, 'cat-file', '-e', 'main:AGENTS.md'])).status ===
    0;
  return {
    nodeEnv: process.env.NODE_ENV,
    envFile,
    envFileExists: fs.existsSync(envFile),
    existingVolumes: docker ? await volumes(composeProject, devStack) : [],
    docker,
    hostMemoryBytes: os.totalmem(),
    ollamaTags:
      settings.model.provider === 'ollama' ? await ollamaTags(settings.model.ollamaUrl) : undefined,
    secretFiles: secretFiles(settings).map(fileFact),
    forkInstructions,
    existingCredentials: [settings.personA, settings.personB]
      .flatMap(credentialsFiles)
      .filter((f) => fs.existsSync(f)),
    keyFile: {
      path: keyFileFor(envFile),
      exists: fs.existsSync(keyFileFor(envFile)),
      gitIgnored: fs.existsSync(path.dirname(keyFileFor(envFile)))
        ? await gitIgnored(keyFileFor(envFile))
        : null,
    },
  };
}

export async function isDockerDesktop(): Promise<boolean> {
  const r = await exec('docker', ['info', '--format', '{{.OperatingSystem}}']);
  return /Docker Desktop/i.test(r.stdout);
}

export { OLLAMA_TAG };
