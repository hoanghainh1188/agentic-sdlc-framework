// ESLint rule: enforce dependency rules between workspace packages (design/D-03 AP4, ADR-M16).
//
// Each import is mapped to the workspace package it lands in:
// - `@sdlc/<name>` (and sub-paths) by package name;
// - relative paths by resolving them against the importing file.
// Imports of third-party packages and imports inside the same package are ignored.
//
// Options: { rules: [{ from, deny?, allowOnly? }] }
// - `from`: package name pattern of the importing package (`*` matches any characters).
// - `deny`: package name patterns that `from` must not import.
// - `allowOnly`: the only workspace packages that `from` may import.

import fs from 'node:fs';
import path from 'node:path';

const SCOPE = '@sdlc/';

/** Folders that contain workspace packages (mirror of pnpm-workspace.yaml). */
const PACKAGE_PARENTS = ['platform/apps', 'platform/packages', 'platform/packages/adapters'];

function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesAny(name, patterns) {
  return patterns.some((p) => patternToRegExp(p).test(name));
}

/** Returns [{ dir, name }] for every workspace package, longest directory first. */
function loadPackages(root) {
  const packages = [];
  for (const parent of PACKAGE_PARENTS) {
    const parentDir = path.join(root, parent);
    if (!fs.existsSync(parentDir)) continue;
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(parentDir, entry.name, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const { name } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      packages.push({ dir: path.join(parentDir, entry.name), name });
    }
  }
  return packages.sort((a, b) => b.dir.length - a.dir.length);
}

// Case-insensitive: on macOS and Windows `../Adapters/Git-Github` still resolves to the adapter.
function packageOfPath(packages, file) {
  const target = file.toLowerCase();
  return packages.find((p) => {
    const dir = p.dir.toLowerCase();
    return target === dir || target.startsWith(dir + path.sep);
  })?.name;
}

function packageOfSpecifier(packages, specifier, importingFile) {
  if (specifier.startsWith(SCOPE)) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  if (specifier.startsWith('.')) {
    return packageOfPath(packages, path.resolve(path.dirname(importingFile), specifier));
  }
  return undefined;
}

/** Returns the string value of a literal module specifier, or undefined. */
function specifierOf(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  // `import('x').Type` in type positions: argument is a TSLiteralType.
  if (node.type === 'TSLiteralType') return specifierOf(node.literal);
  return undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
const moduleBoundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce dependency rules between workspace packages' },
    schema: [
      {
        type: 'object',
        properties: {
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                deny: { type: 'array', items: { type: 'string' } },
                allowOnly: { type: 'array', items: { type: 'string' } },
              },
              required: ['from'],
              additionalProperties: false,
            },
          },
        },
        required: ['rules'],
        additionalProperties: false,
      },
    ],
    messages: {
      denied: '{{from}} must not import {{target}} (module boundary, see design/ADR-M16).',
      notAllowed:
        '{{from}} may only import {{allowed}}; {{target}} is not allowed (module boundary, see design/ADR-M16).',
      computed:
        '{{from}} must use a static string for dynamic imports, so module boundaries can be checked (see design/ADR-M16).',
    },
  },

  create(context) {
    const packages = loadPackages(context.cwd);
    const from = packageOfPath(packages, path.resolve(context.filename));
    if (!from) return {};

    const rules = context.options[0].rules.filter((r) => patternToRegExp(r.from).test(from));
    if (rules.length === 0) return {};

    function check(sourceNode) {
      const specifier = specifierOf(sourceNode);
      if (specifier === undefined) return;
      const target = packageOfSpecifier(packages, specifier, path.resolve(context.filename));
      if (!target || target === from) return;

      for (const rule of rules) {
        if (rule.deny && matchesAny(target, rule.deny)) {
          context.report({ node: sourceNode, messageId: 'denied', data: { from, target } });
          return;
        }
        if (rule.allowOnly && !matchesAny(target, rule.allowOnly)) {
          context.report({
            node: sourceNode,
            messageId: 'notAllowed',
            data: { from, target, allowed: rule.allowOnly.join(', ') },
          });
          return;
        }
      }
    }

    // A computed specifier (`import(name)`, `import(`@sdlc/${x}`)`) cannot be checked, so it is
    // not allowed in packages that have boundary rules.
    function checkDynamic(sourceNode) {
      if (specifierOf(sourceNode) === undefined) {
        context.report({
          node: sourceNode ?? context.sourceCode.ast,
          messageId: 'computed',
          data: { from },
        });
        return;
      }
      check(sourceNode);
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => checkDynamic(node.source),
      TSImportType: (node) => check(node.argument),
      TSExternalModuleReference: (node) => checkDynamic(node.expression),
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          checkDynamic(node.arguments[0]);
        }
      },
    };
  },
};

export default {
  meta: { name: 'sdlc-local' },
  rules: { 'module-boundaries': moduleBoundaries },
};
