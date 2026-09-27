// The live GitHub tests (tests/integration/github/live.test.ts, and the C04 pilot test in
// tests/integration/sandbox-image/pilot-live.test.ts) must never run in CI with real keys
// (design/ADR-M23 §2.7, ADR-M25): the CI workflow sets none of their variables.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

describe('live GitHub test stays out of CI', () => {
  it('no workflow sets SDLC_GITHUB_LIVE_TEST, SDLC_SANDBOX_LIVE_TEST or SDLC_GITHUB_TEST_APP_FILE', () => {
    const dir = path.join(repoRoot(), '.github/workflows');
    for (const file of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(text, file).not.toContain('SDLC_GITHUB_LIVE_TEST');
      expect(text, file).not.toContain('SDLC_GITHUB_TEST_APP_FILE');
      // C04: the pilot live test with the test App key (tests/integration/sandbox-image).
      expect(text, file).not.toContain('SDLC_SANDBOX_LIVE_TEST');
      expect(text, file).not.toContain('test:sandbox-live');
    }
  });
});
