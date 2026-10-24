// H04 (D-08 H04 AC1, AC3; ADR-M93; QUESTIONS #586–#590): the secret scan of a run's diff, outside
// the sandbox. Added lines only; the rules of the base commit's `.gitleaks.toml` or the built-in
// set; the run event holds codes and counts, never a match or a path.
//
// The fake secrets are built at run time from random bytes (never written in the repository, so the
// repository's own Gitleaks scan does not flag this file). The tests with the real Gitleaks run when
// `SDLC_RUNNER_GITLEAKS_PATH` names it (`platform/deploy/scripts/gitleaks.sh`); in CI they must run.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkRunEvent } from '../../packages/core/src/run-events/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addedLines,
  configExtendsFile,
  reportRuleIds,
  ruleCodes,
  scanDiffForSecrets,
  scanFilePath,
  secretsScannedPayload,
  type SecretScan,
} from '../../apps/runner/src/index.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomOf(alphabet: string, length: number): string {
  return [...crypto.randomBytes(length)].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Fake secrets a scanner recognises; random, never real. */
function fakeSecrets() {
  const aws = 'AKIA' + randomOf(BASE32, 16);
  const github = 'ghp' + '_' + randomOf(ALNUM, 36);
  const body = crypto
    .randomBytes(192)
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n');
  const key = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
  const end = ['-----END', 'RSA PRIVATE KEY-----'].join(' ');
  return { aws, github, privateKey: `${key}\n${body}\n${end}` };
}

describe('addedLines: only the added lines, per file and hunk', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    ' kept',
    '-removed line',
    '+added one',
    '@@ -10,1 +10,2 @@',
    '+++ looks like a header but is added',
    ' context',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-old secret line',
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/caf\\303\\251.txt"',
    '@@ -0,0 +1 @@',
    '+bonjour',
    'diff --git a/img.png b/img.png',
    'GIT binary patch',
    'literal 4',
    'LcmZQzWMT#Y01f~L',
    '',
  ].join('\n');

  it('keeps added lines, drops removed, context, deleted files and binary patches', () => {
    expect(addedLines(patch)).toEqual([
      { path: 'src/a.ts', text: 'added one\n\n++ looks like a header but is added\n' },
      { path: 'café.txt', text: 'bonjour\n' },
    ]);
  });

  it('an empty patch has no added lines', () => {
    expect(addedLines('')).toEqual([]);
  });
});

describe('scanFilePath, configExtendsFile, ruleCodes, reportRuleIds', () => {
  it('keeps plain relative paths, gives a neutral name to anything else', () => {
    expect(scanFilePath('src/a.ts', 0)).toBe('src/a.ts');
    expect(scanFilePath('../etc/passwd', 1)).toBe('__sdlc_unnamed/1');
    expect(scanFilePath('/abs', 2)).toBe('__sdlc_unnamed/2');
    expect(scanFilePath('a//b', 3)).toBe('__sdlc_unnamed/3');
    expect(scanFilePath('a\nb', 4)).toBe('__sdlc_unnamed/4');
    // Gitleaks' own files: scanned, never read as its configuration or ignore list.
    expect(scanFilePath('.gitleaksignore', 5)).toBe('__sdlc_unnamed/5');
    expect(scanFilePath('sub/.GitLeaks.toml', 6)).toBe('__sdlc_unnamed/6');
  });

  it('refuses a configuration that extends another file (QUESTIONS #586)', () => {
    expect(configExtendsFile('[extend]\nuseDefault = true\n')).toBe(false);
    expect(configExtendsFile('[extend]\npath = "/etc/x.toml"\n')).toBe(true);
    expect(configExtendsFile('extend = { path = "x.toml" }\n')).toBe(true);
    expect(configExtendsFile("[[rules]]\nid = \"x\"\npath = '''\\.env$'''\n")).toBe(false);
  });

  it('rule codes are distinct, sorted, codes only and capped at 128 characters', () => {
    expect(ruleCodes(['private-key', 'aws-access-token', 'private-key'])).toEqual([
      'aws-access-token',
      'private-key',
    ]);
    expect(ruleCodes(['my rule with spaces', 'a@b'])).toEqual(['custom']);
    const many = Array.from({ length: 20 }, (_, i) => `rule-number-${String(i).padStart(2, '0')}`);
    expect(ruleCodes(many).join(':').length).toBeLessThanOrEqual(128);
  });

  it('reads only the rule IDs of a Gitleaks report', () => {
    expect(reportRuleIds('[]')).toEqual([]);
    expect(reportRuleIds('[{"RuleID":"a","Secret":"REDACTED","File":"x"}]')).toEqual(['a']);
    expect(reportRuleIds('not json')).toBeNull();
    expect(reportRuleIds('{"RuleID":"a"}')).toBeNull();
    expect(reportRuleIds('[{"File":"x"}]')).toBeNull();
  });
});

describe('secretsScannedPayload: codes and counts only', () => {
  it('passes the run event check; a match, a line or a path is refused', () => {
    const scan: SecretScan = {
      result: 'found',
      findings: 3,
      ruleIds: ['aws-access-token', 'private-key'],
      rules: 'built_in',
      configSha256: 'a'.repeat(64),
      scannerVersion: '8.30.1',
    };
    const payload = secretsScannedPayload(scan);
    expect(checkRunEvent('secrets_scanned', payload)).toEqual({
      result: 'found',
      findings: 3,
      rules: 'built_in',
      rule_ids: 'aws-access-token:private-key',
      config_sha256: 'a'.repeat(64),
      scanner_version: '8.30.1',
    });
    const failed = secretsScannedPayload({
      ...scan,
      result: 'failed',
      findings: 0,
      ruleIds: [],
      cause: 'timeout',
    });
    expect(checkRunEvent('secrets_scanned', failed)).toMatchObject({ cause: 'timeout' });
    expect(() => checkRunEvent('secrets_scanned', { ...payload, file: 'src/a.ts' })).toThrow();
    expect(() => checkRunEvent('secrets_scanned', { ...payload, rule_ids: 'a b' })).toThrow();
    expect(() =>
      checkRunEvent('secrets_scanned', { ...payload, rule_ids: 'x'.repeat(129) }),
    ).toThrow();
  });
});

// The real Gitleaks, on a real clone and patch.
const GITLEAKS = process.env.SDLC_RUNNER_GITLEAKS_PATH;
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly cloneDir: string;
  readonly baseSha: string;
  readonly patch: Buffer;
}

/** A clone with `base` committed, then `change` written on top; the patch as the runner computes it. */
function fixture(base: Record<string, string>, change: Record<string, string | null>): Fixture {
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-h04-'));
  dirs.push(cloneDir);
  const repo = path.join(cloneDir, 'repo');
  fs.mkdirSync(path.join(cloneDir, 'home'));
  fs.mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'buffer' });
  git('init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries({ 'README.md': 'fixture\n', ...base })) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD').toString('utf8').trim();
  for (const [file, text] of Object.entries(change)) {
    const target = path.join(repo, file);
    if (text === null) fs.rmSync(target);
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  }
  git('add', '-A');
  const patch = git('diff', '--cached', '--no-renames', '--binary', '--full-index', baseSha);
  return { cloneDir, baseSha, patch };
}

function scan(f: Fixture, gitleaksPath = GITLEAKS!): Promise<SecretScan> {
  return scanDiffForSecrets({
    settings: { gitleaksPath, timeoutMs: 60_000 },
    cloneDir: f.cloneDir,
    baseSha: f.baseSha,
    gitTimeoutMs: 30_000,
    patch: f.patch,
  });
}

/** The scan's run event never holds a fake secret, a path or a line. */
function expectNoSecretIn(result: SecretScan, values: readonly string[]) {
  const text = JSON.stringify(secretsScannedPayload(result));
  for (const value of [...values, 'src/', 'config/', '.env']) expect(text).not.toContain(value);
}

if (process.env.CI && !GITLEAKS) {
  throw new Error('CI: set SDLC_RUNNER_GITLEAKS_PATH (platform/deploy/scripts/gitleaks.sh)');
}

// Gitleaks starts in about a second; a busy machine needs more than the default 5 s.
describe.runIf(GITLEAKS)('scanDiffForSecrets with the real Gitleaks', { timeout: 30_000 }, () => {
  it('AC1/AC3: finds fake secrets in added lines; the event holds codes and counts only', async () => {
    const s = fakeSecrets();
    const f = fixture(
      { 'src/app.ts': 'export const x = 1;\n' },
      {
        'src/app.ts': `export const x = 1;\nconst aws = "${s.aws}"; // gitleaks:allow\n`,
        'config/deploy.env': `GITHUB_TOKEN=${s.github}\n`,
        'keys/id_rsa': `${s.privateKey}\n`,
      },
    );
    const result = await scan(f);
    expect(result).toMatchObject({ result: 'found', rules: 'built_in' });
    expect(result.findings).toBeGreaterThanOrEqual(3);
    expect(result.ruleIds).toEqual(
      expect.arrayContaining(['aws-access-token', 'github-pat', 'private-key']),
    );
    expect(result.scannerVersion).toMatch(/^v?8\.30\.1$/);
    expectNoSecretIn(result, [s.aws, s.github, s.privateKey.split('\n')[1]!]);
    // The scan folder is removed.
    expect(fs.existsSync(path.join(f.cloneDir, 'secret-scan'))).toBe(false);
  });

  it('AC3: a harmless diff is clean', async () => {
    const f = fixture(
      {},
      { 'src/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n' },
    );
    expect(await scan(f)).toMatchObject({ result: 'clean', findings: 0, ruleIds: [] });
  });

  it('a secret only in removed lines or a deleted file is not a finding (added lines only)', async () => {
    const s = fakeSecrets();
    const f = fixture(
      { 'src/old.ts': `const k = "${s.aws}";\n`, 'old.env': `T=${s.github}\n` },
      { 'src/old.ts': 'const k = process.env.K;\n', 'old.env': null },
    );
    expect(await scan(f)).toMatchObject({ result: 'clean', findings: 0 });
  });

  it("QUESTIONS #586: the base commit's .gitleaks.toml applies (an allowlisted path)", async () => {
    const s = fakeSecrets();
    const config = [
      '[extend]',
      'useDefault = true',
      '[allowlist]',
      "paths = ['''^fixtures/''']",
      '',
    ].join('\n');
    const f = fixture({ '.gitleaks.toml': config }, { 'fixtures/key.txt': `k=${s.aws}\n` });
    expect(await scan(f)).toMatchObject({ result: 'clean', rules: 'repository' });
  });

  it('QUESTIONS #586: a .gitleaks.toml or .gitleaksignore the agent adds is never used', async () => {
    const s = fakeSecrets();
    const f = fixture(
      {},
      {
        '.gitleaks.toml': "[allowlist]\npaths = ['''.*''']\n",
        '.gitleaksignore': 'src/a.ts:aws-access-token:1\n',
        'src/a.ts': `const k = "${s.aws}";\n`,
      },
    );
    expect(await scan(f)).toMatchObject({ result: 'found', rules: 'built_in' });
  });

  it('a secret written into an added .gitleaks.toml is found too', async () => {
    const s = fakeSecrets();
    const f = fixture({}, { '.gitleaks.toml': `# ${s.github}\n[extend]\nuseDefault = true\n` });
    expect(await scan(f)).toMatchObject({ result: 'found' });
  });

  it('QUESTIONS #586: a base configuration that extends another file is refused (failed)', async () => {
    const f = fixture(
      { '.gitleaks.toml': '[extend]\npath = "/etc/passwd"\n' },
      { 'src/a.ts': 'x\n' },
    );
    expect(await scan(f)).toMatchObject({
      result: 'failed',
      cause: 'config_refused',
      rules: 'repository',
    });
  });

  it('QUESTIONS #587: a configuration Gitleaks refuses fails the scan, never passes it', async () => {
    const f = fixture(
      { '.gitleaks.toml': '[[rules]]\nid = "x"\nregex = "("\n' },
      { 'a.txt': 'x\n' },
    );
    expect(await scan(f)).toMatchObject({ result: 'failed', cause: 'scanner_failed' });
  });
});

describe('scanDiffForSecrets without Gitleaks', () => {
  it('QUESTIONS #587: a missing scanner is a failed scan, never an exception', async () => {
    const f = fixture({}, { 'a.txt': 'x\n' });
    expect(await scan(f, '/nonexistent/gitleaks')).toMatchObject({
      result: 'failed',
      cause: 'scanner_missing',
      findings: 0,
    });
  });
});
