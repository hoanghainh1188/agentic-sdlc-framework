import { defineConfig } from 'vitest/config';

// Integration tests need the Compose core profile (A02); CI runs them in the `compose` job.
export default defineConfig({
  test: {
    include: ['platform/tests/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
  },
});
