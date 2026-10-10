// Builds the npm package `agentic-sdlc-cli` (task V05, design/ADR-M72) into platform/apps/cli/npm-dist/:
// the compiled CLI and every package it uses bundled into one CommonJS file (Rolldown), the
// shipped default project configuration, the licences of the bundled packages, and package.json
// from the template with the platform version. Run after `tsc -b platform/apps/cli`
// (`pnpm cli:pack` does both). Nothing is published here: only the tag workflow publishes.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { rolldown } from 'rolldown';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'platform', 'apps', 'cli');
const OUT = path.join(CLI, 'npm-dist');

/** Licences that allow commercial use and redistribution (D-02 NFR-04); anything else stops the build. */
const ALLOWED_LICENCES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
]);

/** Optional `pg` modules, loaded only inside guarded `require` calls; never needed by the CLI. */
const EXTERNAL = ['pg-native', 'pg-cloudflare'];

/** The root package.json version and `PLATFORM_VERSION` must be equal (one release, one number). */
async function releaseVersion() {
  const root = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const source = await readFile(path.join(CLI, 'src', 'version.ts'), 'utf8');
  const match = /PLATFORM_VERSION = '([^']+)'/.exec(source);
  if (match?.[1] !== root.version) {
    throw new Error(
      `version mismatch: package.json ${root.version}, PLATFORM_VERSION ${match?.[1] ?? 'missing'}`,
    );
  }
  return root.version;
}

/** The directory of the npm package that holds `file`, or undefined for workspace sources. */
function packageDirOf(file) {
  const parts = file.split(path.sep);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return undefined;
  const scoped = parts[at + 1]?.startsWith('@');
  return parts.slice(0, at + (scoped ? 3 : 2)).join(path.sep);
}

/** `THIRD-PARTY-NOTICES`: name, version, licence and licence text of every bundled npm package. */
async function thirdPartyNotices(moduleIds) {
  const dirs = [...new Set(moduleIds.map(packageDirOf).filter((dir) => dir !== undefined))];
  const entries = [];
  for (const dir of dirs) {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.name?.startsWith('@sdlc/')) continue; // this repository, covered by LICENSE
    if (!ALLOWED_LICENCES.has(pkg.license)) {
      throw new Error(
        `${pkg.name}@${pkg.version}: licence ${pkg.license ?? 'missing'} is not allowed`,
      );
    }
    const text = (await licenceText(dir)) ?? `${pkg.license} (the package ships no licence file)`;
    entries.push({ name: pkg.name, version: pkg.version, license: pkg.license, text });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const blocks = entries.map(
    (e) => `${e.name}@${e.version} (${e.license ?? 'see text'})\n\n${e.text.trim()}\n`,
  );
  return `Third-party software bundled in agentic-sdlc-cli\n\n${blocks.join('\n---\n\n')}`;
}

async function licenceText(dir) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE']) {
    try {
      return await readFile(path.join(dir, name), 'utf8');
    } catch {
      // try the next name
    }
  }
  return undefined;
}

async function main() {
  const version = await releaseVersion();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'bin'), { recursive: true });
  await mkdir(path.join(OUT, 'defaults'), { recursive: true });

  const bundle = await rolldown({
    input: path.join(CLI, 'dist', 'main.js'),
    platform: 'node',
    external: EXTERNAL,
    logLevel: 'warn',
  });
  // The bundle lives in bin/: @sdlc/config reads `<__dirname>/../defaults/…`, which is then the
  // package's own defaults/ folder.
  const { output } = await bundle.write({
    file: path.join(OUT, 'bin', 'sdlc.cjs'),
    format: 'cjs',
    sourcemap: false,
  });
  await bundle.close();
  const chunk = output.find((item) => item.type === 'chunk');
  if (chunk === undefined) throw new Error('rolldown wrote no chunk');

  await copyFile(
    path.join(ROOT, 'platform', 'packages', 'config', 'defaults', 'project-config.default.yaml'),
    path.join(OUT, 'defaults', 'project-config.default.yaml'),
  );
  await copyFile(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'));
  await copyFile(path.join(CLI, 'npm', 'README.md'), path.join(OUT, 'README.md'));
  await writeFile(
    path.join(OUT, 'THIRD-PARTY-NOTICES'),
    await thirdPartyNotices(Object.keys(chunk.modules)),
  );

  const template = JSON.parse(
    await readFile(path.join(CLI, 'npm', 'package.template.json'), 'utf8'),
  );
  await writeFile(
    path.join(OUT, 'package.json'),
    `${JSON.stringify({ ...template, version }, null, 2)}\n`,
  );
  process.stdout.write(`agentic-sdlc-cli ${version}: ${path.relative(ROOT, OUT)}\n`);
}

await main();
