// A GitHub-only check of the App (task V07, QUESTIONS #400): the App's permissions and, for each
// repository, whether the App is installed there, on which repositories and with which permissions
// the installer accepted. Read only: `GET /app` and `GET /repos/{owner}/{repo}/installation` with
// the App JWT; no installation token is minted. Not a `GitHostAdapter` method (D-03 §7.1 is
// unchanged): only the worker's `doctor-github.js` calls it, and `pnpm doctor` compares the answer
// with the App manifest. The answer holds codes and repository names only, never a key or a token.
import { GitHostError, type RepoRef } from '@sdlc/contracts';

import { AppAuth } from './app-auth.js';
import { GitHubHttp } from './http.js';
import { checkRepo, obj, optStr } from './json.js';
import { resolveOptions, type GitHubAdapterOptions } from './options.js';

/** Permission name → level, as GitHub names them (`read`, `write`, `admin`). */
export type AppPermissions = Readonly<Record<string, string>>;

export type RepoInstallation =
  | {
      readonly repo: string;
      readonly installed: true;
      readonly selection: 'all' | 'selected';
      readonly permissions: AppPermissions;
    }
  | { readonly repo: string; readonly installed: false };

export interface InstallationReport {
  readonly app: { readonly permissions: AppPermissions };
  readonly repos: readonly RepoInstallation[];
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const LEVEL = /^(read|write|admin)$/;

/** Only well-formed `name: level` pairs; anything else from the host is dropped. */
function permissionsOf(value: unknown, field: string): AppPermissions {
  const out: Record<string, string> = {};
  for (const [name, level] of Object.entries(obj(value, field))) {
    if (NAME.test(name) && typeof level === 'string' && LEVEL.test(level)) out[name] = level;
  }
  return out;
}

export async function inspectInstallation(
  options: GitHubAdapterOptions,
  repos: readonly RepoRef[],
): Promise<InstallationReport> {
  const resolved = resolveOptions(options);
  const http = new GitHubHttp(resolved);
  const auth = new AppAuth(resolved, http);
  const app = await http.json('GET', 'app', { auth: await auth.appAuthorization() });
  const report: RepoInstallation[] = [];
  for (const ref of repos) {
    const repo = checkRepo(ref);
    const name = `${repo.owner}/${repo.name}`;
    try {
      const res = await http.json('GET', `repos/${repo.owner}/${repo.name}/installation`, {
        auth: await auth.appAuthorization(),
      });
      const body = obj(res.body, 'installation');
      const selection = optStr(body.repository_selection, 'installation.repository_selection');
      report.push({
        repo: name,
        installed: true,
        selection: selection === 'all' ? 'all' : 'selected',
        permissions: permissionsOf(body.permissions, 'installation.permissions'),
      });
    } catch (error) {
      if (error instanceof GitHostError && error.code === 'not_found') {
        report.push({ repo: name, installed: false });
        continue;
      }
      throw error;
    }
  }
  return {
    app: { permissions: permissionsOf(obj(app.body, 'app').permissions, 'app.permissions') },
    repos: report,
  };
}
