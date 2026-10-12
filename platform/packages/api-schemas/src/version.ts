// The platform's release version, as the root `package.json` names it: one number for the API,
// the CLI and the dashboard (task V07, QUESTIONS #401). `GET /v1/me` returns it
// (`platform_version`), `sdlc --version` prints it, `sdlc doctor` compares the two. The release
// gate (`platform/tools/release/release-check.mjs`) and a test keep it equal to `package.json`;
// change both for a release (RELEASING.md).
export const PLATFORM_VERSION = '0.2.1';
