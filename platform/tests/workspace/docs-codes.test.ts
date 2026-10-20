// D-08 W01 AC3 (R016, R024b in design/RULES.md):
// - the handbook never names the internal documents used to design it;
// - no old code (G0, G9–G12, "Level 0–3") comes back in the handbook, the design documents or the
//   platform's source. The exceptions below name the reason each one is not an old code.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers';

const root = repoRoot();

function files(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === 'dist' ? [] : files(rel, ext);
    return ext.test(entry.name) ? [rel.split(path.sep).join('/')] : [];
  });
}

const OLD_CODES = /\bG(?:0|9|1[0-2])\b|\bLevel [0-3]\b/g;

/** file → the lines that may hold an old-looking code, and why. */
const EXCEPTIONS: Record<string, { match: string; why: string }[]> = {
  // A test comment posts an invalid gate on purpose: the poller must ignore it.
  'design/ADR-M27-github-poller.md': [{ match: 'G9', why: 'an invalid gate in a live test' }],
  // The register quotes the old codes in the rule that forbids them.
  'design/RULES.md': [
    { match: 'G0', why: 'the rule R024b itself' },
    { match: 'G12', why: 'the rule R024b itself' },
  ],
  // A version history row from before the codes table (2026-09-24); history is never rewritten.
  'design/D-03-mvp-architecture.md': [{ match: 'Level 1', why: 'version history 0.4' }],
};

describe('W01: the handbook names no internal design source (R016)', () => {
  it.each(files('handbook', /\.md$/))('%s', (file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    expect(text).not.toMatch(/Bản chất|Digital_Foundry/);
  });
});

describe('W01: no old codes (R024b)', () => {
  const scanned = [
    ...files('handbook', /\.md$/),
    ...files('design', /\.md$/),
    ...files('platform/apps', /\.(ts|tsx|json)$/),
    ...files('platform/packages', /\.(ts|json)$/),
  ];

  it('scans the documents and the source', () => {
    expect(scanned.length).toBeGreaterThan(100);
  });

  it('finds only the listed exceptions', () => {
    const found: Record<string, string[]> = {};
    for (const file of scanned) {
      const matches = fs.readFileSync(path.join(root, file), 'utf8').match(OLD_CODES);
      if (matches) found[file] = [...new Set(matches)];
    }
    const allowed = Object.fromEntries(
      Object.entries(EXCEPTIONS).map(([file, list]) => [file, list.map((e) => e.match)]),
    );
    expect(found).toEqual(allowed);
  });
});
