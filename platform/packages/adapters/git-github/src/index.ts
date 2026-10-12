// Git host adapter: GitHub (design/D-03 section 7.1, D-08 B05, ADR-M23). A GitHub App with
// short-lived installation tokens; events read by polling; webhook check kept ready.
export { ADAPTER_PERMISSIONS } from './app-auth.js';
export { GitHubAdapter, MAX_COMMENT_CHARS, MAX_PULL_REQUEST_FILES } from './adapter.js';
export { DEFAULT_GITHUB_APP_SECRET_PATH, type GitHubAdapterOptions } from './options.js';
export {
  DEFAULT_GITHUB_OAUTH_SECRET_PATH,
  GitHubSignIn,
  type GitHubSignInOptions,
} from './sign-in.js';
// V07 (QUESTIONS #400): the App check of `pnpm doctor`, GitHub only, not a `GitHostAdapter` method.
export {
  inspectInstallation,
  type AppPermissions,
  type InstallationReport,
  type RepoInstallation,
} from './inspect.js';
