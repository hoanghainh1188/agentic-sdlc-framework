// D-08 W01 AC3 (R085b in design/RULES.md, ADR-M73, ADR-M82 §2.7): a session writes only to the
// routes marked `@SessionAction`. Before U07 these are the sign-in routes, the passkey routes and
// the four evaluation plan actions of L05 (create, change, archive, Run now). A new mark fails
// here until its task's ADR allows it and this list changes with it.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const API_SRC = path.join(repoRoot(), 'platform/apps/api/src');

const ALLOWED: Record<string, number> = {
  'auth/sign-in.controller.ts': 2,
  'passkeys/passkeys.controller.ts': 4,
  'evaluations/evaluations.controller.ts': 4,
  'intents/intents.controller.ts': 1,
  'runs/runs.controller.ts': 1,
  'escalations/escalations.controller.ts': 2,
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('W01: routes a session may write to (R085b)', () => {
  it('marks only the allowed routes with @SessionAction', () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(API_SRC)) {
      const count = (fs.readFileSync(file, 'utf8').match(/^\s*@SessionAction\(/gm) ?? []).length;
      if (count > 0) found[path.relative(API_SRC, file).split(path.sep).join('/')] = count;
    }
    expect(found).toEqual(ALLOWED);
  });
});
