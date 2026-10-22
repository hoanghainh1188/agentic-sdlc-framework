#!/usr/bin/env node
// Licence check of OpenCode's dependency tree (task X03, design/ADR-M68 §5, QUESTIONS #524 option
// a). The image ships one Bun-compiled binary, so Trivy cannot see the packages inside it. This
// script reads the lockfile of OpenCode's repository at the Git tag of the pinned version, walks
// the runtime dependencies of `packages/opencode` (with the optional ones, without the dev ones),
// and reads each package's licence from the npm registry at its locked version.
//
//   node platform/sandbox-images/node24-opencode/licences.mjs          # CI: fails on a finding
//   node platform/sandbox-images/node24-opencode/licences.mjs --list   # also prints every package
//
// A package passes when its SPDX expression can be satisfied with ALLOWED licences only. A package
// without a usable licence field passes only with a reviewed entry in licence-exceptions.json
// (the licence a person read in the package's repository, and where). Network: GitHub and the npm
// registry. Nothing secret is read or printed.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** The pinned OpenCode version: equal to the Dockerfile (a unit test checks it). */
export const VERSION = '1.18.35';
const REPO = 'anomalyco/opencode';
const WORKSPACE = 'packages/opencode';

/**
 * Licences a sandbox may ship (D-02 NFR-04, ADR-M10 §2.1): permissive ones, and MPL-2.0 (weak,
 * file-level copyleft: used unmodified inside the binary). The CRITICAL category (AGPL, SSPL,
 * commercial) and the GPL family never pass.
 */
export const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'Unlicense',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'Python-2.0',
  'Zlib',
  'MPL-2.0',
]);

/** SPDX identifiers compare without case (`apache-2.0` is `Apache-2.0`). */
const ALLOWED_LOWER = new Set([...ALLOWED].map((id) => id.toLowerCase()));

/** True when the SPDX expression can be met with allowed licences only. Unknown syntax fails. */
export function allowedExpression(expression) {
  const tokens = String(expression)
    .replace(/[()]/g, (p) => ` ${p} `)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  const peek = () => tokens[i];
  function primary() {
    const token = tokens[i++];
    if (token === '(') {
      const value = or();
      if (tokens[i++] !== ')') throw new Error('syntax');
      return value;
    }
    if (token === undefined || ['AND', 'OR', ')'].includes(token)) throw new Error('syntax');
    return ALLOWED_LOWER.has(token.replace(/\+$/, '').toLowerCase());
  }
  function and() {
    let value = primary();
    while (peek() === 'AND') {
      i += 1;
      value = primary() && value;
    }
    return value;
  }
  function or() {
    let value = and();
    while (peek() === 'OR') {
      i += 1;
      value = and() || value;
    }
    return value;
  }
  try {
    const value = or();
    return i === tokens.length && value;
  } catch {
    return false;
  }
}

/** bun.lock is JSON with trailing commas. */
export function parseBunLock(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * The npm packages (`name@version`) the runtime of `workspace` needs. A dependency of the lock
 * entry at key `a/b` resolves to `a/b/<dep>`, then `a/<dep>`, then `<dep>` (Bun's nesting). Other
 * workspaces are followed through their own dependencies. Anything not from the registry is
 * returned in `unresolved`.
 */
export function runtimeTree(lock, workspace) {
  const packages = lock.packages ?? {};
  const found = new Map();
  const unresolved = new Set();
  const seenKeys = new Set();
  const seenWorkspaces = new Set();
  const queue = [];
  const depsOf = (entry) => ({ ...entry?.dependencies, ...entry?.optionalDependencies });
  const enqueueWorkspace = (name) => {
    if (seenWorkspaces.has(name)) return;
    seenWorkspaces.add(name);
    for (const dep of Object.keys(depsOf(lock.workspaces?.[name]))) queue.push(['', dep]);
  };
  enqueueWorkspace(workspace);
  while (queue.length > 0) {
    const [parent, dep] = queue.shift();
    let key;
    for (
      let scope = parent;
      ;
      scope = scope.includes('/') ? scope.slice(0, scope.lastIndexOf('/')) : ''
    ) {
      const candidate = scope === '' ? dep : `${scope}/${dep}`;
      if (packages[candidate]) {
        key = candidate;
        break;
      }
      if (scope === '') break;
    }
    if (key === undefined) {
      unresolved.add(dep);
      continue;
    }
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const [spec, registry, meta] = packages[key];
    const at = spec.lastIndexOf('@');
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (version.startsWith('workspace:')) {
      const ws = Object.entries(lock.workspaces ?? {}).find(([, w]) => w.name === name)?.[0];
      if (ws === undefined) unresolved.add(spec);
      else enqueueWorkspace(ws);
      continue;
    }
    if (registry !== '' || !/^\d+\.\d+\.\d+/.test(version)) {
      unresolved.add(spec);
      continue;
    }
    found.set(`${name}@${version}`, { name, version });
    for (const child of Object.keys(depsOf(meta))) queue.push([key, child]);
  }
  return { packages: [...found.values()], unresolved: [...unresolved].sort() };
}

/** The licence field of a package version as an SPDX expression, or undefined. */
export function licenceOf(manifest) {
  const field = manifest?.license ?? manifest?.licenses;
  if (typeof field === 'string') return field;
  if (
    field &&
    typeof field === 'object' &&
    !Array.isArray(field) &&
    typeof field.type === 'string'
  ) {
    return field.type;
  }
  if (Array.isArray(field) && field.length > 0) {
    const types = field.map((l) => (typeof l === 'string' ? l : l?.type));
    if (types.every((t) => typeof t === 'string')) return types.join(' OR ');
  }
  return undefined;
}

async function fetchText(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt >= 4) throw new Error(`${url}: ${error.message}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function main() {
  const list = process.argv.includes('--list');
  const here = path.dirname(new URL(import.meta.url).pathname);
  const exceptions = JSON.parse(await readFile(path.join(here, 'licence-exceptions.json'), 'utf8'));
  const raw = `https://raw.githubusercontent.com/${REPO}/v${VERSION}`;
  const manifest = JSON.parse(await fetchText(`${raw}/${WORKSPACE}/package.json`));
  if (manifest.version !== VERSION)
    throw new Error(`tag v${VERSION} has version ${manifest.version}`);
  const lock = parseBunLock(await fetchText(`${raw}/bun.lock`));
  const { packages, unresolved } = runtimeTree(lock, WORKSPACE);

  const results = [];
  let next = 0;
  async function worker() {
    while (next < packages.length) {
      const pkg = packages[next++];
      const url = `https://registry.npmjs.org/${pkg.name.replace('/', '%2F')}/${pkg.version}`;
      const licence = licenceOf(JSON.parse(await fetchText(url)));
      const exception = exceptions[`${pkg.name}@${pkg.version}`];
      const effective =
        licence !== undefined && licence !== 'UNLICENSED' ? licence : exception?.licence;
      results.push({
        ...pkg,
        licence: effective ?? 'none',
        ok: effective !== undefined && allowedExpression(effective),
      });
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
  results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const byLicence = new Map();
  for (const r of results) byLicence.set(r.licence, (byLicence.get(r.licence) ?? 0) + 1);
  console.log(
    `OpenCode ${VERSION}: ${results.length} npm packages in the runtime tree of ${WORKSPACE}`,
  );
  for (const [licence, count] of [...byLicence].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${licence}`);
  }
  if (list)
    for (const r of results)
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}@${r.version} ${r.licence}`);
  const failed = results.filter((r) => !r.ok);
  const unexpected = unresolved.filter((spec) => !exceptions[spec]);
  for (const r of failed) console.error(`not allowed: ${r.name}@${r.version} (${r.licence})`);
  for (const spec of unexpected)
    console.error(`not from the npm registry, no reviewed exception: ${spec}`);
  if (failed.length > 0 || unexpected.length > 0) process.exit(1);
  console.log('licence check passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  await main();
}
