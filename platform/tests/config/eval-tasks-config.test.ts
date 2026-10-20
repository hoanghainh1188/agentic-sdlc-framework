// Task L07 (ADR-M85 §2.4): `evaluation.tasks` names the hidden tests of a merged pull request and
// the commands `sdlc eval task draft` proposes. Globs stay inside the repository; commands are
// plain words for `sh -c` in the scoring container (no shell syntax).
import { describe, expect, it } from 'vitest';

import { loadErrors, loadValid } from './helpers';

const tasks = (body: string) => `evaluation:\n  tasks:\n${body}`;

describe('evaluation.tasks (L07)', () => {
  it('defaults: three test globs and no proposed command', () => {
    expect(loadValid().config.evaluation.tasks).toEqual({
      test_globs: ['**/*.test.*', '**/*.spec.*', 'test/**'],
      commands: { fail_to_pass: [], pass_to_pass: [], ci: [] },
    });
  });

  it('accepts a project’s own globs and command templates with {file}', () => {
    const { config } = loadValid(
      tasks(
        [
          '    test_globs: ["apps/*/src/**/*.spec.ts", "e2e/**"]',
          '    commands:',
          '      fail_to_pass: ["pnpm --filter @pilot/api test -- {file}"]',
          '      pass_to_pass: ["pnpm --filter @pilot/api test"]',
          '      ci: ["pnpm --filter @pilot/api typecheck", "pnpm lint"]',
          '',
        ].join('\n'),
      ),
    );
    expect(config.evaluation.tasks.test_globs).toEqual(['apps/*/src/**/*.spec.ts', 'e2e/**']);
    expect(config.evaluation.tasks.commands.fail_to_pass).toEqual([
      'pnpm --filter @pilot/api test -- {file}',
    ]);
  });

  it.each(['../other/**', '/etc/**', '.git/**', 'a b', ''])('refuses the glob %j', (glob) => {
    const errors = loadErrors(tasks(`    test_globs: [${JSON.stringify(glob)}]\n`));
    expect(errors.map((e) => e.path)).toContain('evaluation.tasks.test_globs[0]');
  });

  it('refuses an empty glob list', () => {
    const errors = loadErrors(tasks('    test_globs: []\n'));
    expect(errors.map((e) => e.path)).toContain('evaluation.tasks.test_globs');
  });

  it.each(['pnpm test; rm -rf /', 'pnpm test && curl x', 'echo $(id)', 'pnpm test | tee x', '-rf'])(
    'refuses the command %j',
    (command) => {
      const errors = loadErrors(tasks(`    commands:\n      ci: [${JSON.stringify(command)}]\n`));
      expect(errors.map((e) => e.path)).toContain('evaluation.tasks.commands.ci[0]');
    },
  );
});
