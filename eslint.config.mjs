// ESLint flat config for the platform (design/ADR-M16).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import sdlcLocal from './platform/tools/eslint-rules/module-boundaries.mjs';

export default tseslint.config(
  {
    // Documents are never linted or changed by tools. Only platform code and root config files are.
    ignores: [
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
    files: ['**/*.mjs', '**/*.js'],
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
            // Core depends on interfaces, never on a concrete adapter.
            { from: '@sdlc/core', deny: ['@sdlc/adapter-*'] },
            // Adapters implement interfaces from contracts and depend on nothing else in the workspace.
            { from: '@sdlc/adapter-*', allowOnly: ['@sdlc/contracts'] },
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
