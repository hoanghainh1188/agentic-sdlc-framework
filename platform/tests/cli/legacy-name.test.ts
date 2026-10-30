// The old command name `sdlc` (design/ADR-M100 §2.2): both names in the workspace package and the
// root scripts until v0.10.0, the note through the message catalog. The installed binaries are
// run by `pnpm cli:pack-check` (CI job `checks`).
import fs from 'node:fs';
import path from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { startedAsLegacyName } from '../../apps/cli/src/legacy-name.js';
import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const json = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;

describe('the old name sdlc (ADR-M100 §2.2)', () => {
  it.each([
    ['/usr/local/bin/sdlc', true],
    ['/usr/lib/node_modules/@hoanghainh/governed-adlc/bin/sdlc.cjs', true],
    ['/repo/platform/apps/cli/dist/sdlc.js', true],
    ['/usr/local/bin/adlc', false],
    ['/usr/lib/node_modules/@hoanghainh/governed-adlc/bin/adlc.cjs', false],
    ['/repo/platform/apps/cli/dist/main.js', false],
    ['/opt/sdlc/bin/adlc', false],
    ['/usr/local/bin/sdlc-other', false],
    [undefined, false],
  ])('%s → %s', (script, legacy) => {
    expect(startedAsLegacyName(script)).toBe(legacy);
  });

  it('the note says the new name and comes from the catalog', () => {
    expect(t('cli.renamed')).toContain('`sdlc` is now `adlc`');
    expect(t('cli.renamed')).toContain('@hoanghainh/governed-adlc');
    expect(t('cli.renamed')).toContain('v0.10.0');
  });

  it('no message tells a person to run the old command (only the note names it)', () => {
    const catalog = json('platform/packages/messages/src/locales/en.json') as Record<
      string,
      string
    >;
    // `sdlc:intent=` is the machine marker of the platform's GitHub comments, not a command.
    const oldCommand = /(?:^|[\s`(])(?:pnpm )?sdlc(?=[ :])(?!:intent=)/;
    const found = Object.entries(catalog).filter(([, text]) => oldCommand.test(text));
    expect(found.map(([key]) => key)).toEqual([]);
    expect(t('cli.help.overview')).toMatch(/^adlc: /);
  });

  it('the workspace package installs both names; the root has pnpm adlc and the alias pnpm sdlc', () => {
    expect(json('platform/apps/cli/package.json').bin).toEqual({
      adlc: 'dist/main.js',
      sdlc: 'dist/sdlc.js',
    });
    const scripts = json('package.json').scripts as Record<string, string>;
    expect(scripts.adlc).toMatch(/node platform\/apps\/cli\/dist\/main\.js$/);
    expect(scripts.sdlc).toMatch(/node platform\/apps\/cli\/dist\/sdlc\.js$/);
  });
});
