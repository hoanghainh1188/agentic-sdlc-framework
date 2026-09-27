// The gitleaks rule `sdlc-api-token` (task B03, ADR-M26 D6): every platform token matches it, and
// only the fake fixture in platform/tests/gitleaks/fixtures is allow-listed. CI also runs the real
// gitleaks binary against a fresh token (ci.yml, "Rule self-test").
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateApiToken } from '../../packages/core/src/admin/tokens.js';
import { repoRoot } from '../workspace/helpers';

const config = fs.readFileSync(path.join(repoRoot(), '.gitleaks.toml'), 'utf8');

function block(start: string): string {
  const from = config.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const next = config.indexOf('[[', from + start.length);
  return config.slice(from, next === -1 ? undefined : next);
}

describe('gitleaks rule sdlc-api-token', () => {
  const rule = block('id = "sdlc-api-token"');
  const regex = new RegExp(/regex = '''(.+)'''/.exec(rule)![1]!);

  it('matches every generated platform token', () => {
    for (let i = 0; i < 50; i++) expect(generateApiToken()).toMatch(regex);
  });

  it('allow-lists only FAKE tokens in the fixture folder', () => {
    const allow = block('description = "Fake platform token fixture');
    expect(allow).toContain('targetRules = ["sdlc-api-token"]');
    expect(allow).toContain('condition = "AND"');
    expect(allow).toContain("paths = ['''^platform/tests/gitleaks/fixtures/[^/]+$''']");
    expect(allow).toContain("regexes = ['''FAKE''']");
    const fixture = fs.readFileSync(
      path.join(repoRoot(), 'platform/tests/gitleaks/fixtures/fake-platform-token.txt'),
      'utf8',
    );
    const found = fixture.match(new RegExp(regex.source, 'g')) ?? [];
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('FAKE');
  });
});
