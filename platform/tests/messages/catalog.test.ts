// Message catalog (design/D-02 NFR-08, ADR-M18): user-facing text comes from the catalog, with the
// same keys and placeholders in every locale.
import fs from 'node:fs';
import path from 'node:path';

import { catalogFor, placeholdersOf, SUPPORTED_LOCALES, t, type MessageKey } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const en = catalogFor('en')!;
const enKeys = Object.keys(en) as MessageKey[];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    // U01: the dashboard's screens are TSX.
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('message catalog', () => {
  it('renders placeholders', () => {
    expect(t('config.schema.too_small', { path: 'a.b', minimum: 3 })).toBe(
      'a.b: the value must be at least 3.',
    );
  });

  it('keeps a placeholder visible when its value is missing', () => {
    expect(t('config.schema.too_small', { path: 'a.b' })).toBe(
      'a.b: the value must be at least {minimum}.',
    );
  });

  it('falls back to English for an unknown locale', () => {
    expect(t('config.path.root', {}, 'xx')).toBe(t('config.path.root'));
  });

  it('uses dotted lower-case keys and non-empty English text', () => {
    for (const key of enKeys) {
      expect(key).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
      expect(en[key]?.trim()).not.toBe('');
    }
  });

  it.each(SUPPORTED_LOCALES.filter((locale) => locale !== 'en'))(
    'locale %s has the same keys and placeholders as English',
    (locale) => {
      const catalog = catalogFor(locale)!;
      expect(Object.keys(catalog).sort()).toEqual([...enKeys].sort());
      for (const key of enKeys) {
        expect(placeholdersOf(catalog[key] ?? '').sort(), key).toEqual(
          placeholdersOf(en[key] ?? '').sort(),
        );
      }
    },
  );

  it('has no unused keys: every key appears in platform code', () => {
    const code = ['platform/packages', 'platform/apps']
      .flatMap((dir) => sourceFiles(path.join(root, dir)))
      .filter(
        (file) => !file.includes(`${path.sep}dist${path.sep}`) && !file.includes('node_modules'),
      )
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    // JSX attributes quote keys with double quotes (`messageKey="…"`).
    expect(
      enKeys.filter((key) => !code.includes(`'${key}'`) && !code.includes(`"${key}"`)),
    ).toEqual([]);
  });
});
