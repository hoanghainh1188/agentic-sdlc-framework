// Checks the npm package of the CLI (task V05, design/ADR-M72) that `build.mjs` wrote, before CI
// accepts it and before the tag workflow publishes it:
// 1. `npm pack --dry-run`: the package holds exactly the allowed files (no test fixture, source
//    map, .env or anything else);
// 2. no packed file holds an absolute path of the build machine, a source map reference, an API
//    token or a private key;
// 3. the tarball installs into an empty folder outside the repository (`npm install -g --prefix`)
//    and `sdlc --version` prints the version, `sdlc` alone prints the usage text (exit 2).
// `--out <dir>` keeps the tarball there (the tag workflow uploads it). Never publishes.
import { execFile } from 'node:child_process';
import { access, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PKG = path.join(ROOT, 'platform', 'apps', 'cli', 'npm-dist');

/** Exactly the files the package may hold (npm adds package.json, README and LICENSE itself). */
const PACKED_FILES = [
  'LICENSE',
  'README.md',
  'THIRD-PARTY-NOTICES',
  'bin/sdlc.cjs',
  'defaults/project-config.default.yaml',
  'package.json',
];

/** Text that must never be in a packed file. */
const FORBIDDEN = [
  { name: 'absolute path of this checkout', test: (text) => text.includes(ROOT) },
  { name: 'macOS home path', test: (text) => /\/Users\/[A-Za-z0-9._-]+\//.test(text) },
  { name: 'Linux home or runner path', test: (text) => /\/home\/[A-Za-z0-9._-]+\//.test(text) },
  { name: 'source map reference', test: (text) => text.includes('sourceMappingURL=') },
  { name: 'platform API token', test: (text) => /sdlc_pat_[A-Za-z0-9_-]{20,}/.test(text) },
  { name: 'private key', test: (text) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) },
];

function fail(message) {
  process.stderr.write(`cli-package check: ${message}\n`);
  process.exit(1);
}

async function packedFiles() {
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: PKG,
  });
  const [result] = JSON.parse(stdout);
  return result.files.map((file) => file.path).sort();
}

async function checkContents(files) {
  const extra = files.filter((file) => !PACKED_FILES.includes(file));
  const missing = PACKED_FILES.filter((file) => !files.includes(file));
  if (extra.length > 0 || missing.length > 0) {
    fail(
      `unexpected package contents: extra [${extra.join(', ')}], missing [${missing.join(', ')}]`,
    );
  }
  for (const file of files) {
    const text = await readFile(path.join(PKG, file), 'utf8');
    for (const rule of FORBIDDEN) {
      if (rule.test(text)) fail(`${file} holds a ${rule.name}`);
    }
  }
}

/** Runs the installed command with a clean environment and an empty home folder. */
async function sdlc(bin, args, home) {
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  try {
    const { stdout, stderr } = await run(bin, args, { cwd: home, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function checkInstall(version, outDir) {
  const work = await mkdtemp(path.join(tmpdir(), 'sdlc-cli-check-'));
  try {
    const { stdout } = await run(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', work],
      {
        cwd: PKG,
      },
    );
    const [{ filename, size }] = JSON.parse(stdout);
    const tarball = path.join(work, filename);
    const prefix = path.join(work, 'prefix');
    const home = path.join(work, 'home');
    await run('mkdir', ['-p', home]);
    await run(
      'npm',
      ['install', '-g', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      { cwd: home, env: { ...process.env, HOME: home } },
    );
    const bin = path.join(prefix, 'bin', 'sdlc');
    const installed = path.join(prefix, 'lib', 'node_modules', 'agentic-sdlc-cli');
    await access(path.join(installed, 'defaults', 'project-config.default.yaml'));

    const versionRun = await sdlc(bin, ['--version'], home);
    if (versionRun.code !== 0 || versionRun.stdout.trim() !== version) {
      fail(`sdlc --version: exit ${versionRun.code}, output "${versionRun.stdout.trim()}"`);
    }
    const usageRun = await sdlc(bin, [], home);
    if (usageRun.code !== 2 || !usageRun.stderr.startsWith('Usage: sdlc')) {
      fail(`sdlc without arguments: exit ${usageRun.code}, no usage text`);
    }
    if (outDir !== undefined) await copyFile(tarball, path.join(outDir, filename));
    process.stdout.write(`cli-package check: ${filename} (${size} bytes) installs and runs\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const outAt = process.argv.indexOf('--out');
  const outDir = outAt > 0 ? path.resolve(process.argv[outAt + 1] ?? '') : undefined;
  const { version } = JSON.parse(await readFile(path.join(PKG, 'package.json'), 'utf8'));
  await checkContents(await packedFiles());
  await checkInstall(version, outDir);
}

await main();
