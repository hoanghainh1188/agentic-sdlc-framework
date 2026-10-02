// Tracing must be registered before `pg` and the HTTP servers are loaded (design/ADR-M35 §2.3):
// the instrumentations patch a module when it is required after they are registered.
// - The api and the worker import `./telemetry.js` first.
// - `@sdlc/telemetry` imports `@sdlc/core` (which loads `pg`) for types only.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();

function importLines(file: string): string[] {
  return fs
    .readFileSync(path.join(root, file), 'utf8')
    .split('\n')
    .filter((line) => /^import\s/.test(line));
}

describe('tracing load order (ADR-M35 §2.3)', () => {
  it.each(['platform/apps/api/src/main.ts', 'platform/apps/worker/src/main.ts'])(
    '%s imports ./telemetry.js first',
    (file) => {
      expect(importLines(file)[0]).toMatch(/from '\.\/telemetry\.js';$/);
    },
  );

  it('@sdlc/telemetry imports @sdlc/core for types only', () => {
    const dir = 'platform/packages/telemetry/src';
    const coreImports = fs
      .readdirSync(path.join(root, dir))
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => importLines(path.join(dir, f)))
      .filter((line) => line.includes("'@sdlc/core'"));
    expect(coreImports.length).toBeGreaterThan(0);
    for (const line of coreImports) expect(line).toMatch(/^import type /);
  });
});
