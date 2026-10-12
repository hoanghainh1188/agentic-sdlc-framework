// Gathers the facts of `pnpm doctor` on the machine of the stack (D-08 V07 AC1, AC3). Every
// command comes from `commands.ts` and runs through the allowlist of `exec.ts`; outputs are parsed
// into facts at once and dropped. It reads the env file through `env-facts.ts` (allowlisted keys
// only), the TLS certificates (never the key file) and files of this checkout. It writes nothing.
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadProjectConfig } from '@sdlc/config';

import {
  APPROLE_FOLDERS,
  commands,
  PINNED_IMAGE,
  SQL_MIGRATIONS,
  SQL_PROJECTS,
  type ComposeTarget,
} from './commands.js';
import { parseEnvFacts, requiredSecrets } from './env-facts.js';
import type { Exec } from './exec.js';
import { manifestPermissions } from './github-permissions.js';
import { findLogEvents } from './logs.js';
import type {
  AppRoleFact,
  CertFact,
  GitHubFact,
  OpenBaoState,
  OperatorFacts,
  ProjectImageFact,
  RepoFact,
  ServiceState,
} from './types.js';

export interface HostPaths {
  readonly repoRoot: string;
  readonly envFile: string;
}

const DAY_MS = 86_400_000;
const TLS_FILES = ['ca.pem', 'server.pem', 'server-key.pem'] as const;

export function deployPaths(repoRoot: string) {
  const deploy = path.join(repoRoot, 'platform/deploy');
  return {
    composeFile: path.join(deploy, 'docker-compose.yml'),
    envExample: path.join(deploy, '.env.example'),
    bootstrap: path.join(deploy, 'openbao/bootstrap.sh'),
    images: path.join(deploy, 'scripts/images.sh'),
    manifest: path.join(deploy, 'github-app/manifest.json'),
    migrations: path.join(repoRoot, 'platform/packages/core/src/db/migrations'),
  };
}

function statMode(file: string): number | null {
  try {
    return fs.statSync(file).mode;
  } catch {
    return null;
  }
}

function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** `docker compose ps --format json`: one array, or one object per line (Compose versions). */
export function parsePs(text: string): ServiceState[] | null {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  let rows: unknown[];
  try {
    rows = trimmed.startsWith('[')
      ? (JSON.parse(trimmed) as unknown[])
      : trimmed.split('\n').map((line) => JSON.parse(line) as unknown);
  } catch {
    return null;
  }
  const out: ServiceState[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.Service !== 'string') continue;
    out.push({
      service: r.Service,
      state: typeof r.State === 'string' ? r.State : '',
      health: typeof r.Health === 'string' ? r.Health : '',
      exitCode: typeof r.ExitCode === 'number' ? r.ExitCode : 0,
    });
  }
  return out;
}

export function parseOpenBaoStatus(status: number | null, stdout: string): OpenBaoState {
  if (status !== 0) return 'unreachable';
  const m = /OpenBao is (uninitialised|sealed|unsealed)/.exec(stdout);
  return (m?.[1] as OpenBaoState | undefined) ?? 'unreachable';
}

export function parseValkeyMemory(text: string): { usedBytes: number; maxBytes: number } | null {
  const used = /^used_memory:(\d+)/m.exec(text)?.[1];
  const max = /^maxmemory:(\d+)/m.exec(text)?.[1];
  return used === undefined || max === undefined
    ? null
    : { usedBytes: Number(used), maxBytes: Number(max) };
}

/** `owner/name` of a repository; never `.` or `..` as a part. */
function isRepoName(value: string): boolean {
  const parts = value.split('/');
  return (
    parts.length === 2 &&
    parts.every((p) => /^[A-Za-z0-9._-]{1,100}$/.test(p) && p !== '.' && p !== '..')
  );
}

/** The JSON line of the worker's `doctor-github.js`, checked field by field. */
export function parseWorkerGitHub(status: number | null, stdout: string): GitHubFact {
  if (status !== 0) {
    return { ok: false, error: /Cannot find module/.test(stdout) ? 'not_built' : 'exec_failed' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    return { ok: false, error: 'invalid_answer' };
  }
  const p = parsed as Record<string, unknown>;
  if (p.ok !== true) {
    return {
      ok: false,
      error:
        typeof p.error === 'string' && /^[a-z_]{1,64}$/.test(p.error) ? p.error : 'invalid_answer',
    };
  }
  const perms = (value: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (typeof value !== 'object' || value === null) return out;
    for (const [k, v] of Object.entries(value)) {
      if (
        /^[a-z][a-z0-9_]{0,63}$/.test(k) &&
        typeof v === 'string' &&
        /^(read|write|admin)$/.test(v)
      )
        out[k] = v;
    }
    return out;
  };
  const app = p.app as Record<string, unknown> | undefined;
  const repos: RepoFact[] = [];
  for (const r of Array.isArray(p.repos) ? (p.repos as Record<string, unknown>[]) : []) {
    if (typeof r.repo !== 'string' || !isRepoName(r.repo)) continue;
    repos.push(
      r.installed === true
        ? {
            repo: r.repo,
            installed: true,
            selection: r.selection === 'all' ? 'all' : 'selected',
            permissions: perms(r.permissions),
          }
        : { repo: r.repo, installed: false },
    );
  }
  return { ok: true, app: { permissions: perms(app?.permissions) }, repos };
}

export function parseAppRole(
  status: number | null,
  stdout: string,
  now: Date,
): Pick<AppRoleFact, 'state' | 'ageDays'> {
  const out = stdout.trim();
  if (status !== 0) return { state: 'unreadable' };
  if (out === 'missing') return { state: 'missing' };
  if (!/^\d{1,12}$/.test(out)) return { state: 'unreadable' };
  return { state: 'ok', ageDays: Math.floor((now.getTime() - Number(out) * 1000) / DAY_MS) };
}

function certFact(name: CertFact['name'], file: string): CertFact {
  try {
    const cert = new X509Certificate(fs.readFileSync(file));
    return { name, notAfter: new Date(cert.validTo).toISOString() };
  } catch {
    return { name, notAfter: null };
  }
}

function migrationNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .map((f) => /^(\d{4}-[a-z0-9-]+)\.ts$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .sort();
  } catch {
    return [];
  }
}

function jsonArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text.trim()) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const running = (services: readonly ServiceState[] | null | undefined, name: string) =>
  services?.some((s) => s.service === name && s.state === 'running') === true;

export async function gatherFacts(
  paths: HostPaths,
  exec: Exec,
  now = new Date(),
): Promise<OperatorFacts> {
  const files = deployPaths(paths.repoRoot);
  const manifest = manifestPermissions(fs.readFileSync(files.manifest, 'utf8'));
  const exists = fs.existsSync(paths.envFile);
  const required = requiredSecrets(fs.readFileSync(files.envExample, 'utf8'));
  const envFacts = exists
    ? parseEnvFacts(fs.readFileSync(paths.envFile, 'utf8'), required)
    : undefined;
  const envFile = {
    path: paths.envFile,
    exists,
    mode: statMode(paths.envFile),
    ...(envFacts ? { facts: envFacts } : {}),
  };

  const disk = [
    { path: path.dirname(paths.envFile), freeBytes: freeBytes(path.dirname(paths.envFile)) },
  ];
  const backupDir = envFacts?.values.SDLC_BACKUP_DIR;
  if (backupDir) disk.push({ path: backupDir, freeBytes: freeBytes(backupDir) });

  const version = await exec(commands.dockerVersion());
  const docker =
    version.status !== 0
      ? null
      : {
          serverVersion: version.stdout.trim() || null,
          composeVersion: await exec(commands.composeVersion()).then((r) =>
            r.status === 0 ? r.stdout.trim() : null,
          ),
          memoryBytes: await exec(commands.dockerMemory()).then((r) =>
            r.status === 0 ? Number(r.stdout.trim()) || null : null,
          ),
        };

  const mode = await exec(commands.imagesMode(files.images));
  const imagesMode =
    mode.status === 0 && /^(local|published)$/.test(mode.stdout.trim())
      ? (mode.stdout.trim() as 'local' | 'published')
      : 'failed';
  const base: OperatorFacts = { now, envFile, docker, disk, manifest, imagesMode };
  const tlsDir = envFacts?.values.SDLC_OPENBAO_TLS_DIR ?? null;
  const tls = {
    dir: tlsDir,
    missing: tlsDir
      ? TLS_FILES.filter((f) => !fs.existsSync(path.join(tlsDir, f)))
      : [...TLS_FILES],
    certs: tlsDir
      ? [
          certFact('ca', path.join(tlsDir, 'ca.pem')),
          certFact('server', path.join(tlsDir, 'server.pem')),
        ]
      : [],
  };
  if (!docker || !envFacts) return { ...base, tls };

  const target: ComposeTarget = {
    composeFile: files.composeFile,
    envFile: paths.envFile,
    project: envFacts.values.COMPOSE_PROJECT_NAME ?? 'deploy',
  };
  const ps = await exec(commands.ps(target));
  const services = ps.status === 0 ? parsePs(ps.stdout) : null;
  const facts: OperatorFacts = { ...base, tls, services };
  if (!services || services.length === 0) return facts;

  const openbao = running(services, 'openbao')
    ? await exec(commands.openbaoStatus(files.bootstrap), { SDLC_ENV_FILE: paths.envFile }).then(
        (r) => parseOpenBaoStatus(r.status, r.stdout),
      )
    : undefined;

  let migrations: OperatorFacts['migrations'];
  let projects: OperatorFacts['projects'];
  if (running(services, 'postgres')) {
    const applied = await exec(commands.psql(target, SQL_MIGRATIONS));
    const names = applied.status === 0 ? jsonArray(applied.stdout) : null;
    migrations = {
      expected: migrationNames(files.migrations),
      applied:
        names?.filter((n): n is string => typeof n === 'string') ??
        (/kysely_migration.*does not exist/.test(applied.stderr) ? [] : null),
    };
    projects = await projectImages(exec, target);
  }

  const approles: AppRoleFact[] = [];
  for (const f of APPROLE_FOLDERS) {
    if (!running(services, f.service)) {
      approles.push({ service: f.service, credentials: f.credentials, state: 'not_running' });
      continue;
    }
    const r = await exec(commands.approle(target, f.service, f.folder));
    approles.push({
      service: f.service,
      credentials: f.credentials,
      ...parseAppRole(r.status, r.stdout, now),
    });
  }

  const platformUp = ['sdlc-api', 'sdlc-worker', 'sdlc-runner'].some((s) => running(services, s));
  const logs = platformUp
    ? await exec(commands.logs(target)).then((r) =>
        r.status === 0 ? findLogEvents(r.stdout) : null,
      )
    : undefined;
  const valkey = running(services, 'valkey')
    ? await exec(commands.valkey(target)).then((r) =>
        r.status === 0 ? parseValkeyMemory(r.stdout) : null,
      )
    : undefined;
  const github =
    running(services, 'sdlc-worker') && openbao === 'unsealed'
      ? await exec(commands.workerGitHub(target)).then((r) =>
          parseWorkerGitHub(r.status, `${r.stdout}\n${r.stderr}`),
        )
      : undefined;
  return {
    ...facts,
    ...(openbao ? { openbao } : {}),
    ...(migrations ? { migrations } : {}),
    ...(projects !== undefined ? { projects } : {}),
    approles,
    ...(logs !== undefined ? { logs } : {}),
    ...(valkey !== undefined ? { valkey } : {}),
    ...(github ? { github } : {}),
  };
}

async function projectImages(
  exec: Exec,
  target: ComposeTarget,
): Promise<ProjectImageFact[] | null> {
  const r = await exec(commands.psql(target, SQL_PROJECTS));
  const rows = r.status === 0 ? jsonArray(r.stdout) : null;
  if (!rows) return null;
  const out: ProjectImageFact[] = [];
  for (const row of rows) {
    const { project, config } = (row ?? {}) as { project?: unknown; config?: unknown };
    if (typeof project !== 'string') continue;
    const loaded = loadProjectConfig(typeof config === 'string' ? config : '');
    const image = loaded.ok ? loaded.config.sandbox.image : null;
    let present: boolean | null = null;
    if (image !== null && PINNED_IMAGE.test(image)) {
      present = (await exec(commands.imageInspect(image))).status === 0;
    }
    out.push({ project, image, present });
  }
  return out;
}
