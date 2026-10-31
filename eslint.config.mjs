// ESLint flat config for the platform (design/ADR-M16).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import sdlcLocal from './platform/tools/eslint-rules/module-boundaries.mjs';

// Rules of CLAUDE.md checked by lint (task W01 PR 3, ADR-M84; IDs in design/RULES.md).
// `no-restricted-syntax` takes one list per file, so a block that adds a selector repeats these.
const AUDIT_INSERT = {
  selector: "CallExpression[callee.property.name='insertInto'][arguments.0.value='audit_log']",
  message: 'Audit events are written only through TenantScope.audit.append (R075c).',
};
const TEMPORAL_SCHEDULE = {
  selector:
    "MemberExpression[property.name='create'][object.type='MemberExpression'][object.property.name='schedule']",
  message:
    'Clocks, retention and spend sync are plain worker loops, never Temporal schedules (R044c).',
};

export default tseslint.config(
  {
    // Documents are never linted or changed by tools. Only platform code and root config files are.
    ignores: [
      '.claude/',
      'handbook/',
      'design/',
      '_review/',
      'diagrams/',
      '*.md',
      'scripts/',
      '.github/',
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      // The npm package build of the CLI (V05): a generated bundle.
      'platform/apps/cli/npm-dist/',
      // The evaluation tasks (L02): code of the sample repository (its Jest tests, its patches), not
      // platform code; kept exactly as the task check ran it.
      'platform/eval/tasks/',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          // Root config files are not part of any tsconfig project.
          allowDefaultProject: ['*.ts', 'platform/apps/dashboard/*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Plain scripts, and the declaration files that give tests the types of a script (for
    // example platform/tools/release/tag-release.d.mts): no tsconfig project holds them.
    files: ['**/*.mjs', '**/*.js', '**/*.d.mts'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    // Module boundaries (D-03 AP4, D-08 A01 AC3, ADR-M16).
    files: ['platform/**/*.ts', 'platform/**/*.tsx', 'platform/**/*.mts', 'platform/**/*.cts'],
    plugins: { 'sdlc-local': sdlcLocal },
    rules: {
      '@typescript-eslint/no-require-imports': 'error',
      'sdlc-local/module-boundaries': [
        'error',
        {
          rules: [
            // Core depends on interfaces, never on a concrete adapter or the adapters' helpers.
            { from: '@sdlc/core', deny: ['@sdlc/adapter-*', '@sdlc/agent-kit'] },
            // Adapters implement interfaces from contracts and depend on nothing else in the workspace.
            {
              from: '@sdlc/adapter-*',
              except: ['@sdlc/adapter-agent-*'],
              allowOnly: ['@sdlc/contracts'],
            },
            // Agent adapters also share the helpers of @sdlc/agent-kit (ADR-M88 §2.3), which
            // depends on contracts only.
            { from: '@sdlc/adapter-agent-*', allowOnly: ['@sdlc/contracts', '@sdlc/agent-kit'] },
            { from: '@sdlc/agent-kit', allowOnly: ['@sdlc/contracts'] },
            // The Temporal client wraps the intent workflow's names from contracts (ADR-M30).
            { from: '@sdlc/workflow-client', allowOnly: ['@sdlc/contracts'] },
            // Core never imports Temporal through the workflow client (ADR-M30).
            { from: '@sdlc/core', deny: ['@sdlc/workflow-client'] },
            // Tracing is loaded before `pg`: it imports core for types only, and core never imports
            // it (ADR-M35 §2.3). The type-only rule is checked by platform/tests/observability.
            { from: '@sdlc/telemetry', allowOnly: ['@sdlc/core'] },
            { from: '@sdlc/core', deny: ['@sdlc/telemetry'] },
            // The read-only dashboard (U01, ADR-M54): the shared response schemas only; never
            // another app. The schemas depend on nothing in the workspace.
            { from: '@sdlc/dashboard', allowOnly: ['@sdlc/api-schemas'] },
            { from: '@sdlc/api-schemas', allowOnly: [] },
          ],
        },
      ],
    },
  },

  {
    // R075c: the audit log's one writer is the repository behind TenantScope.audit.append.
    files: ['platform/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', AUDIT_INSERT] },
  },
  {
    files: ['platform/packages/core/src/db/repositories/audit-log.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // R084a: platform code logs only through the platform logger (ADR-M35). Output for people goes
    // through process.stdout / process.stderr and the message catalog.
    files: ['platform/apps/*/src/**/*.{ts,tsx}', 'platform/packages/**/src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // The migration command line runs before any logger exists and prints status for the operator.
    files: ['platform/packages/core/src/db/migrate-cli.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // R044c, R053g: the worker never creates a Temporal schedule.
    files: ['platform/apps/worker/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', AUDIT_INSERT, TEMPORAL_SCHEDULE],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@temporalio/client',
              importNames: ['ScheduleClient'],
              message: TEMPORAL_SCHEDULE.message,
            },
          ],
        },
      ],
    },
  },

  {
    // The dashboard runs in the browser (U01, ADR-M54 §2.3): browser globals; no HTML injection,
    // no browser storage, no network call outside its API client (also checked by
    // platform/tests/dashboard/static.test.ts).
    files: ['platform/apps/dashboard/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Render text with JSX; never inject HTML.' },
        { property: 'outerHTML', message: 'Render text with JSX; never inject HTML.' },
        { object: 'window', property: 'localStorage', message: 'The token stays in memory.' },
        { object: 'window', property: 'sessionStorage', message: 'The token stays in memory.' },
        { object: 'document', property: 'cookie', message: 'The token stays in memory.' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'The token stays in memory (ADR-M54 §2.3).' },
        { name: 'sessionStorage', message: 'The token stays in memory (ADR-M54 §2.3).' },
        { name: 'indexedDB', message: 'The token stays in memory (ADR-M54 §2.3).' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Render text with JSX; never inject HTML.',
        },
      ],
    },
  },

  {
    // Temporal workflow code runs in a deterministic sandbox (ADR-M30 §2.2): it imports only the
    // workflow API, the shared contracts and type-only modules (activities are proxied).
    files: ['platform/apps/worker/src/workflows/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!@temporalio/workflow$|@sdlc/contracts$|\\./|\\.\\./activities/)',
              message: 'Workflow code imports only @temporalio/workflow and @sdlc/contracts.',
            },
            {
              regex: '^\\.\\./activities/',
              allowTypeImports: true,
              message: 'Workflow code may import activity types only.',
            },
          ],
        },
      ],
    },
  },

  prettier,
);
