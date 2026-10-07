// U01 AC5: colour contrast of the dashboard's tokens, light and dark (WCAG 2.2 AA): text 4.5:1,
// bars, focus rings and other non-text marks 3:1 (1.4.11).
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const css = fs.readFileSync(
  path.join(repoRoot(), 'platform/apps/dashboard/src/styles/tokens.css'),
  'utf8',
);

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!]),
  );
}

const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const light = tokens(css.slice(0, darkStart));
const dark = { ...light, ...tokens(css.slice(darkStart)) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SURFACES = ['paper', 'paper-raised', 'paper-sunk'];
const TEXT = ['ink', 'ink-muted', 'accent', 'alert', 'warn', 'ok', 'hotl'];
const MARKS = ['accent-fill', 'alert-fill', 'ink', 'focus'];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme', (_name, theme) => {
  it('defines every token it uses', () => {
    for (const name of [...SURFACES, ...TEXT, ...MARKS, 'masthead', 'masthead-ink']) {
      expect(theme[name], name).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(TEXT.flatMap((text) => SURFACES.map((surface) => [text, surface])))(
    'text %s on %s reaches 4.5:1',
    (text, surface) => {
      expect(ratio(theme[text]!, theme[surface]!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('the primary button, the masthead: 4.5:1', () => {
    expect(ratio(theme.paper!, theme.ink!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(theme.paper!, theme.accent!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(theme['masthead-ink']!, theme.masthead!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MARKS.flatMap((mark) => ['paper', 'paper-raised'].map((surface) => [mark, surface])))(
    'mark %s on %s reaches 3:1',
    (mark, surface) => {
      expect(ratio(theme[mark]!, theme[surface]!)).toBeGreaterThanOrEqual(3);
    },
  );
});
