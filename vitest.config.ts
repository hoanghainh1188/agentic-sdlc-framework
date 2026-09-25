import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['platform/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
