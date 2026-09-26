// The live GitHub test (tests/integration/github/live.test.ts) must never run in CI with real
// keys (design/ADR-M23 §2.7): the CI workflow sets neither of its variables.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

describe('live GitHub test stays out of CI', () => {
  it('no workflow sets SDLC_GITHUB_LIVE_TEST or SDLC_GITHUB_TEST_APP_FILE', () => {
    const dir = path.join(repoRoot(), '.github/workflows');
    for (const file of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(text, file).not.toContain('SDLC_GITHUB_LIVE_TEST');
      expect(text, file).not.toContain('SDLC_GITHUB_TEST_APP_FILE');
    }
  });
});
