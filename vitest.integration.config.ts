import { defineConfig } from 'vitest/config';

import unitConfig from './vitest.config';

// Integration tests need the Compose core profile (A02); CI runs them in the `compose` job.
// Same source aliases as `pnpm test`, so the `db` job needs no build first.
export default defineConfig({
  resolve: unitConfig.resolve,
  test: {
    include: ['platform/tests/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
  },
});
