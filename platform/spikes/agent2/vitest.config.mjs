// X01 spike (design/ADR-M68): the spike's own Vitest configuration, so neither `pnpm test` nor the
// integration suites ever pick it up. Same source aliases as the platform's tests.
import { defineConfig } from 'vitest/config';

import unitConfig from '../../../vitest.config.ts';

export default defineConfig({
  resolve: unitConfig.resolve,
  test: {
    include: ['platform/spikes/agent2/**/*.spike.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: false,
  },
});
