import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['platform/**/*.test.ts'],
    // Integration tests need running infrastructure: `pnpm test:integration`.
    exclude: ['**/node_modules/**', '**/dist/**', 'platform/tests/integration/**'],
  },
});
