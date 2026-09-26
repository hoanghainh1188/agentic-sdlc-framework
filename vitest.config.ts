import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests import workspace packages by name. Point them at the TypeScript sources, so `pnpm test`
// does not need a build first. `pnpm typecheck` checks the same imports against the built types.
const SOURCE_PACKAGES = ['contracts', 'config', 'messages', 'core', 'secrets'];
const SOURCE_ADAPTERS = ['policy-simple', 'model-litellm'];

export default defineConfig({
  resolve: {
    alias: [
      ...SOURCE_PACKAGES.map((name) => ({
        find: `@sdlc/${name}`,
        replacement: path.resolve(import.meta.dirname, `platform/packages/${name}/src/index.ts`),
      })),
      ...SOURCE_ADAPTERS.map((name) => ({
        find: `@sdlc/adapter-${name}`,
        replacement: path.resolve(
          import.meta.dirname,
          `platform/packages/adapters/${name}/src/index.ts`,
        ),
      })),
    ],
  },
  test: {
    include: ['platform/**/*.test.ts'],
    // Integration tests need running infrastructure: `pnpm test:integration`.
    exclude: ['**/node_modules/**', '**/dist/**', 'platform/tests/integration/**'],
  },
});
