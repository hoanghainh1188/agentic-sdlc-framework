// `node /app/dist/doctor-github.js` (task V07, QUESTIONS #400): the GitHub App check of
// `pnpm doctor`, run by the operator with `docker compose exec -T sdlc-worker …`. It logs in with
// the worker's own AppRole (the App key stays in OpenBao and in this process), lists the active
// GitHub projects and asks GitHub, read only, for the App's permissions and each installation
// (`inspectInstallation`). It prints ONE JSON line with codes and repository names only: never the
// key, a JWT, a token or a log line. `pnpm doctor` compares the answer with the App manifest.
// It changes nothing: no table, no OpenBao entry, no GitHub object (an OpenBao login is audited).
import {
  inspectInstallation,
  type InstallationReport,
  type RepoInstallation,
} from '@sdlc/adapter-git-github';
import { GitHostError, type RepoRef } from '@sdlc/contracts';
import type { PlatformLogger } from '@sdlc/core';
import { OpenBaoClient, SecretsError } from '@sdlc/secrets';

import { connectDatabase } from './database.js';
import { loadSettings, SettingsError } from './settings.js';

export type DoctorGitHubOutput =
  | {
      readonly ok: true;
      readonly app: InstallationReport['app'];
      readonly repos: readonly RepoInstallation[];
    }
  | { readonly ok: false; readonly error: string };

export interface DoctorGitHubDeps {
  /** `owner/name` of every active GitHub project. */
  readonly listRepos: () => Promise<readonly string[]>;
  readonly inspect: (repos: readonly RepoRef[]) => Promise<InstallationReport>;
}

/** A code for a failure; never the error's text (it may name a path or an address). */
export function failureCode(error: unknown): string {
  if (error instanceof SecretsError) {
    if (error.key === 'secrets.openbao.sealed') return 'openbao_sealed';
    if (error.key === 'secrets.openbao.not_initialised') return 'openbao_not_initialised';
    if (error.key === 'secrets.login_failed') return 'openbao_login_failed';
    return 'openbao';
  }
  if (error instanceof GitHostError) return `git_host_${error.code}`;
  if (error instanceof SettingsError) return 'settings';
  return 'unexpected';
}

function toRef(fullName: string): RepoRef | undefined {
  const [owner, name, ...rest] = fullName.split('/');
  return owner && name && rest.length === 0 ? { owner, name } : undefined;
}

export async function doctorGitHub(deps: DoctorGitHubDeps): Promise<DoctorGitHubOutput> {
  try {
    const names = [...new Set(await deps.listRepos())].sort();
    const refs = names.map(toRef).filter((ref): ref is RepoRef => ref !== undefined);
    const report = await deps.inspect(refs);
    return { ok: true, app: report.app, repos: report.repos };
  } catch (error) {
    return { ok: false, error: failureCode(error) };
  }
}

const silent: PlatformLogger = { log: () => undefined };

async function main(): Promise<void> {
  let output: DoctorGitHubOutput;
  let close = (): Promise<void> => Promise.resolve();
  try {
    const settings = loadSettings(process.env);
    const openbao = OpenBaoClient.fromEnv(process.env, silent);
    close = () => openbao.close();
    await openbao.assertReady();
    const secrets = openbao.kv();
    const db = await connectDatabase(settings, secrets, silent);
    const previous = close;
    close = async () => {
      await db.close();
      await previous();
    };
    output = await doctorGitHub({
      listRepos: async () => (await db.system.listPollableProjects()).map((p) => p.repoFullName),
      inspect: (repos) =>
        inspectInstallation({ secrets, apiUrl: settings.githubApiUrl, logger: silent }, repos),
    });
  } catch (error) {
    output = { ok: false, error: failureCode(error) };
  }
  await close().catch(() => undefined);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

// Runs only as the entry point (`node dist/doctor-github.js`), never when a test imports it.
if (typeof require !== 'undefined' && require.main === module) void main();
