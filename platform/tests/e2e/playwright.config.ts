// The dashboard's smoke test (U01 AC6, design/ADR-M54 §2.6): `pnpm test:dashboard`. Chromium
// against the stub API (stub-api.mjs), which serves the built dashboard through the api's own
// static route. The test token is made here at run time (never a literal in the repository).
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.SDLC_DASHBOARD_E2E_PORT ?? 4791);
process.env.SDLC_DASHBOARD_E2E_PORT = String(port);
process.env.SDLC_DASHBOARD_E2E_TOKEN ??= `sdlc_pat_${randomBytes(32).toString('base64url')}`;

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts$/,
  outputDir: path.join(__dirname, 'test-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // U05: the GitHub sign-in in Firefox and WebKit too, when their browsers are installed
    // (`pnpm exec playwright install firefox webkit`); CI installs Chromium only.
    ...(process.env.SDLC_DASHBOARD_E2E_ALL_BROWSERS === '1'
      ? [
          {
            name: 'firefox',
            testMatch: /sign-in\.e2e\.ts$/,
            use: { ...devices['Desktop Firefox'] },
          },
          { name: 'webkit', testMatch: /sign-in\.e2e\.ts$/, use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
  webServer: {
    command: `node ${path.join(__dirname, 'stub-api.mjs')}`,
    url: `http://127.0.0.1:${port}/dashboard/`,
    reuseExistingServer: false,
    timeout: 20_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
