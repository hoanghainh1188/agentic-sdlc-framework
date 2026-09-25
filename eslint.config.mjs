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
          allowDefaultProject: ['*.ts'],
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
    files: ['platform/**/*.ts', 'platform/**/*.mts', 'platform/**/*.cts'],
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
          ],
        },
      ],
    },
  },

  prettier,
);
