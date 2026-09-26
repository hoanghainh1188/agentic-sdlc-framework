// Git host adapter: GitHub (design/D-03 section 7.1, D-08 B05, ADR-M23). A GitHub App with
// short-lived installation tokens; events read by polling; webhook check kept ready.
export { ADAPTER_PERMISSIONS } from './app-auth.js';
export { GitHubAdapter, MAX_COMMENT_CHARS, MAX_PULL_REQUEST_FILES } from './adapter.js';
export { DEFAULT_GITHUB_APP_SECRET_PATH, type GitHubAdapterOptions } from './options.js';
