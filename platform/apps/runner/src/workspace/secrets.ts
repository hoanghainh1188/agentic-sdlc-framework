// The secret scan of a run's diff, outside the sandbox (task H04, D-08 H04 AC1, design/ADR-M93,
// ADR-M80 gap G-10, QUESTIONS #586–#590).
//
// The changes step (`changes.ts`) calls `scanDiffForSecrets` with the patch it just stored:
// 1. Only the **added** lines are scanned: per file and per hunk, written into a private folder of
//    the run's clone (mode 700) that mirrors the changed paths, so path allowlists still apply. A
//    path that is not a plain relative path gets a neutral name, and so does a file named like
//    Gitleaks' own files (`.gitleaksignore`, which Gitleaks reads from the scanned folder whatever
//    `--gitleaks-ignore-path` says, and `.gitleaks.toml`, which its default rules skip): their
//    content is scanned, never used. The folder is removed after.
// 2. Rules: the repository's `.gitleaks.toml` read from `base_sha` with hardened git, never from
//    the diff (the agent cannot allowlist itself); a configuration that extends another file
//    (`[extend] path`) is refused. No file: the built-in rules (`useDefault`).
// 3. Gitleaks runs with an explicit configuration and an empty ignore folder (so a
//    `.gitleaks.toml` or `.gitleaksignore` among the added files is never read), ignores
//    `gitleaks:allow` comments (the agent could write them), redacts every secret, and keeps a
//    clean environment and a time limit. Its JSON report is read in memory; only the rule IDs are
//    kept, and its own text (stderr) is never passed on.
// The result holds codes and counts only: never a match, a line, a path or a fingerprint. Every
// failure is a `failed` result with a cause code, never an exception: G5 holds the run on it
// (QUESTIONS #587).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { SecretScanSettings } from '../settings.js';
import { gitIn } from './proposal.js';

export type SecretScanResult = 'clean' | 'found' | 'failed';
export type SecretScanRules = 'repository' | 'built_in';
export type SecretScanCause =
  | 'scanner_missing'
  | 'scanner_failed'
  | 'timeout'
  | 'config_refused'
  | 'config_unreadable'
  | 'output_invalid'
  | 'diff_unreadable';

export interface SecretScan {
  readonly result: SecretScanResult;
  /** Number of findings (each one a rule matching on an added line). */
  readonly findings: number;
  /** Distinct rule codes of the findings, sorted; a rule ID that is not a code is `custom`. */
  readonly ruleIds: readonly string[];
  readonly rules: SecretScanRules;
  /** SHA-256 of the configuration Gitleaks was given (repository file or built-in text). */
  readonly configSha256: string | null;
  /** `gitleaks version` when it is a code; null when unknown. */
  readonly scannerVersion: string | null;
  /** Why the scan failed; only with `failed`. */
  readonly cause?: SecretScanCause;
}

/** The repository's Gitleaks configuration at the base commit (QUESTIONS #586). */
export const REPOSITORY_CONFIG_PATH = '.gitleaks.toml';
/** The built-in rules: Gitleaks' own default set. */
export const BUILT_IN_CONFIG = '[extend]\nuseDefault = true\n';
/** Upper bound of the repository's configuration file. */
export const MAX_CONFIG_BYTES = 256 * 1024;
/** Upper bound of the Gitleaks report read from its standard output. */
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
/** Rule codes kept in the run event (`codes`: at most 128 characters joined by `:`). */
export const MAX_RULE_CODES_LENGTH = 128;

const RULE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const VERSION_CODE = /^v?[0-9]+\.[0-9]+\.[0-9]+$/;
const UNNAMED_DIR = '__sdlc_unnamed';
/** Names Gitleaks treats as its own files (compared without case). */
const GITLEAKS_FILE_NAMES = ['.gitleaksignore', '.gitleaks.toml'];

/** The added lines of one changed file: its path in the patch and the scanned text. */
export interface AddedFile {
  readonly path: string;
  readonly text: string;
}

/**
 * The added lines of a `git diff` patch, per file; hunks of one file are separated by an empty
 * line so a multi-line secret (a private key) stays whole within a hunk. Removed and context lines
 * and binary patches are not scanned. A deleted file has no added lines.
 */
export function addedLines(patch: Buffer | string): AddedFile[] {
  const lines = (typeof patch === 'string' ? patch : patch.toString('utf8')).split('\n');
  const files = new Map<string, string[]>();
  let current: string | null = null;
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      current = newPath(line.slice(4));
    } else if (line.startsWith('@@')) {
      inHunk = current !== null;
      if (inHunk) {
        const added = files.get(current!) ?? [];
        if (added.length > 0) added.push('');
        files.set(current!, added);
      }
    } else if (inHunk && line.startsWith('+')) {
      files.get(current!)!.push(line.slice(1));
    }
  }
  return [...files.entries()]
    .filter(([, added]) => added.some((l) => l.length > 0))
    .map(([file, added]) => ({ path: file, text: `${added.join('\n')}\n` }));
}

/** The new path of a `+++` header (`b/<path>`, C-quoted when unusual); null for `/dev/null`. */
function newPath(raw: string): string | null {
  const value = raw.replace(/\t.*$/, '');
  if (value === '/dev/null') return null;
  const unquoted = value.startsWith('"') ? unquote(value) : value;
  if (unquoted === null || !unquoted.startsWith('b/')) return null;
  return unquoted.slice(2);
}

/** Git's C-style quoting of a path; null when malformed. */
function unquote(quoted: string): string | null {
  if (quoted.length < 2 || !quoted.endsWith('"')) return null;
  const body = quoted.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(octal)) return null;
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else if (next in simple) {
      bytes.push(simple[next]!);
      i += 1;
    } else {
      return null;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Where a changed file's added lines are written in the scan folder: its own path when that is a
 * plain relative path, otherwise a neutral name (path allowlists then do not apply: fail closed).
 * Gitleaks' own file names always get a neutral name (see the header).
 */
export function scanFilePath(file: string, index: number): string {
  const segments = file.split('/');
  const plain =
    file.length > 0 &&
    file.length <= 1024 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f\\]/.test(file) &&
    segments.every((s) => s.length > 0 && s !== '.' && s !== '..') &&
    !GITLEAKS_FILE_NAMES.includes(segments.at(-1)!.toLowerCase());
  return plain ? file : `${UNNAMED_DIR}/${index}`;
}

/** True when a Gitleaks configuration extends another file (`[extend] path`, QUESTIONS #586). */
export function configExtendsFile(text: string): boolean {
  let table = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      table = header[1]!.replace(/["'\s]/g, '');
      continue;
    }
    if (table === 'extend' && /^["']?path["']?\s*=/.test(line)) return true;
    if (table === '' && /^["']?extend["']?\s*=/.test(line) && /\bpath\b/.test(line)) return true;
    if (table === '' && /^["']?extend\.path["']?\s*=/.test(line)) return true;
  }
  return false;
}

/** The rule codes kept for the run event: distinct, sorted, capped (see `MAX_RULE_CODES_LENGTH`). */
export function ruleCodes(ruleIds: readonly string[]): string[] {
  const codes = [...new Set(ruleIds.map((id) => (RULE_CODE.test(id) ? id : 'custom')))].sort();
  const kept: string[] = [];
  let length = 0;
  for (const code of codes) {
    const added = (kept.length > 0 ? 1 : 0) + code.length;
    if (length + added > MAX_RULE_CODES_LENGTH) break;
    kept.push(code);
    length += added;
  }
  return kept;
}

/** The rule IDs of a Gitleaks JSON report; null when it is not one. Nothing else is read. */
export function reportRuleIds(stdout: string): string[] | null {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(report)) return null;
  const ids: string[] = [];
  for (const finding of report) {
    const id = (finding as { RuleID?: unknown } | null)?.RuleID;
    if (typeof id !== 'string') return null;
    ids.push(id);
  }
  return ids;
}

type RunOutcome =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly cause: SecretScanCause };

function runGitleaks(
  settings: SecretScanSettings,
  args: readonly string[],
  cwd: string,
  home: string,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    execFile(
      settings.gitleaksPath,
      args,
      {
        cwd,
        // A clean environment: no GITLEAKS_CONFIG or GITLEAKS_CONFIG_TOML from the runner's.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LC_ALL: 'C' },
        timeout: settings.timeoutMs,
        maxBuffer: MAX_REPORT_BYTES,
        encoding: 'utf8',
      },
      (error, stdout) => {
        // Gitleaks' own text is never passed on: it may quote the configuration or a file.
        if (!error) resolve({ ok: true, stdout });
        else if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          resolve({ ok: false, cause: 'scanner_missing' });
        else if (error.killed) resolve({ ok: false, cause: 'timeout' });
        else resolve({ ok: false, cause: 'scanner_failed' });
      },
    );
  });
}

export interface RepositoryConfig {
  readonly text: Buffer | null;
  readonly cause?: SecretScanCause;
}

/** The repository's `.gitleaks.toml` at `baseSha` (a regular file only), with hardened git. */
export async function repositoryConfig(
  repoDir: string,
  home: string,
  baseSha: string,
  timeoutMs: number,
): Promise<RepositoryConfig> {
  const options = { timeoutMs, maxPatchBytes: MAX_CONFIG_BYTES + 4096 };
  try {
    const entry = (
      await gitIn(repoDir, home, ['ls-tree', '-z', baseSha, '--', REPOSITORY_CONFIG_PATH], options)
    ).toString('utf8');
    if (entry.length === 0) return { text: null };
    // `<mode> <type> <object>\t<path>`: a symbolic link or a folder is refused.
    const [mode, type, object] = entry.split('\t')[0]!.split(' ');
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !object) {
      return { text: null, cause: 'config_refused' };
    }
    const text = await gitIn(repoDir, home, ['cat-file', 'blob', object], options);
    if (text.length > MAX_CONFIG_BYTES) return { text: null, cause: 'config_refused' };
    return { text };
  } catch {
    return { text: null, cause: 'config_unreadable' };
  }
}

export interface ScanInput {
  readonly settings: SecretScanSettings;
  /** The run's clone folder (with `repo` and `home`), kept for the run by `provisionRun`. */
  readonly cloneDir: string;
  readonly baseSha: string;
  /** Hardened git's time limit in the clone. */
  readonly gitTimeoutMs: number;
  readonly patch: Buffer;
}

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Scans the added lines of the run's patch (see the header). Never throws. */
export async function scanDiffForSecrets(input: ScanInput): Promise<SecretScan> {
  const root = path.join(input.cloneDir, 'secret-scan');
  const base = { findings: 0, ruleIds: [] as string[], scannerVersion: null };
  let rules: SecretScanRules = 'built_in';
  let configSha256: string | null = null;
  const failed = (cause: SecretScanCause): SecretScan => ({
    ...base,
    result: 'failed',
    rules,
    configSha256,
    cause,
  });
  try {
    const repo = await repositoryConfig(
      path.join(input.cloneDir, 'repo'),
      path.join(input.cloneDir, 'home'),
      input.baseSha,
      input.gitTimeoutMs,
    );
    if (repo.text !== null) rules = 'repository';
    const config = repo.text ?? Buffer.from(BUILT_IN_CONFIG, 'utf8');
    configSha256 = sha256(config);
    if (repo.cause) return failed(repo.cause);
    if (configExtendsFile(config.toString('utf8'))) return failed('config_refused');

    let files: AddedFile[];
    try {
      files = addedLines(input.patch);
    } catch {
      return failed('diff_unreadable');
    }
    fs.rmSync(root, { recursive: true, force: true });
    for (const dir of ['files', 'ignore', 'home']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
    }
    const configPath = path.join(root, 'config.toml');
    fs.writeFileSync(configPath, config, { mode: 0o600, flag: 'wx' });
    writeAddedFiles(path.join(root, 'files'), files);

    const home = path.join(root, 'home');
    const version = await runGitleaks(input.settings, ['version'], root, home);
    if (!version.ok) return failed(version.cause);
    const scannerVersion = version.stdout.trim();
    const versionCode = VERSION_CODE.test(scannerVersion) ? scannerVersion : null;

    const scan = await runGitleaks(
      input.settings,
      [
        'dir',
        '--no-banner',
        '--no-color',
        '--log-level',
        'error',
        '--redact=100',
        '--ignore-gitleaks-allow',
        '--max-archive-depth',
        '0',
        '--config',
        configPath,
        '--gitleaks-ignore-path',
        path.join(root, 'ignore'),
        '--report-format',
        'json',
        '--report-path',
        '-',
        '--exit-code',
        '0',
        '.',
      ],
      path.join(root, 'files'),
      home,
    );
    if (!scan.ok) return { ...failed(scan.cause), scannerVersion: versionCode };
    const ids = reportRuleIds(scan.stdout);
    if (ids === null) return { ...failed('output_invalid'), scannerVersion: versionCode };
    return {
      result: ids.length > 0 ? 'found' : 'clean',
      findings: ids.length,
      ruleIds: ruleCodes(ids),
      rules,
      configSha256,
      scannerVersion: versionCode,
    };
  } catch {
    return failed('scanner_failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Writes each file's added lines under `dir`; a path taken twice gets a neutral name. */
function writeAddedFiles(dir: string, files: readonly AddedFile[]): void {
  files.forEach((file, index) => {
    const write = (relative: string) => {
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, file.text, { mode: 0o600, flag: 'wx' });
    };
    try {
      write(scanFilePath(file.path, index));
    } catch {
      // A file where a folder must go, or two spellings of one path on this file system.
      write(`${UNNAMED_DIR}/${index}`);
    }
  });
}
