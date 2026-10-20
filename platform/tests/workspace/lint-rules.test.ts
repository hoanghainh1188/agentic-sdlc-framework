// D-08 W01 AC3 (ADR-M84 §2.2, design/RULES.md): the lint rules for rules of CLAUDE.md fire.
// - R084a: no `console.*` in platform code (the logger only);
// - R044c, R053g: the worker creates no Temporal schedule;
// - R075c: only the audit log repository inserts into `audit_log`.
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers';

const eslint = new ESLint({ cwd: repoRoot() });

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.map((m) => m.ruleId ?? '');
}

const WORKER = 'platform/apps/worker/src/main.ts';
const CORE = 'platform/packages/core/src/workflow/step.ts';
const AUDIT_REPOSITORY = 'platform/packages/core/src/db/repositories/audit-log.ts';
const INSERT_AUDIT =
  "declare const db: { insertInto(t: string): void };\ndb.insertInto('audit_log');\n";

describe('W01: lint rules for CLAUDE.md', { timeout: 120_000 }, () => {
  it('R084a: refuses console.* in platform code', async () => {
    expect(await ruleIds(CORE, "console.log('x');\n")).toContain('no-console');
  });

  it('R044c: refuses a Temporal schedule in the worker', async () => {
    expect(
      await ruleIds(
        WORKER,
        "import { ScheduleClient } from '@temporalio/client';\nexport const x = ScheduleClient;\n",
      ),
    ).toContain('@typescript-eslint/no-restricted-imports');
    expect(
      await ruleIds(
        WORKER,
        'declare const client: { schedule: { create(): void } };\nclient.schedule.create();\n',
      ),
    ).toContain('no-restricted-syntax');
  });

  it('R075c: refuses an insert into audit_log outside its repository', async () => {
    expect(await ruleIds(CORE, INSERT_AUDIT)).toContain('no-restricted-syntax');
    expect(await ruleIds(WORKER, INSERT_AUDIT)).toContain('no-restricted-syntax');
    expect(await ruleIds(AUDIT_REPOSITORY, INSERT_AUDIT)).not.toContain('no-restricted-syntax');
  });
});
