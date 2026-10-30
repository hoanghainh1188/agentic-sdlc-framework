// The old command name `sdlc` (design/ADR-M100 §2.2): v0.9.x installed it next to `adlc` for one
// minor release; v0.10.0 removed the binary, the root script `pnpm sdlc` and the note. The old
// login folder `…/sdlc` is still read (ADR-M100 §2.3, `credentials.test.ts`).
import fs from 'node:fs';
import path from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const json = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;

describe('the old name sdlc is gone (ADR-M100, v0.10.0)', () => {
  it('the workspace package, the npm package and the root install only adlc', () => {
    expect(json('platform/apps/cli/package.json').bin).toEqual({ adlc: 'dist/main.js' });
    expect(json('platform/apps/cli/npm/package.template.json').bin).toEqual({
      adlc: 'bin/adlc.cjs',
    });
    const scripts = json('package.json').scripts as Record<string, string>;
    expect(scripts.adlc).toMatch(/node platform\/apps\/cli\/dist\/main\.js$/);
    expect(scripts.sdlc).toBeUndefined();
  });

  it('no entry point or note for the old name is left', () => {
    for (const file of ['sdlc.ts', 'legacy-name.ts']) {
      expect(fs.existsSync(path.join(root, 'platform/apps/cli/src', file)), file).toBe(false);
    }
    const catalog = json('platform/packages/messages/src/locales/en.json');
    expect(Object.hasOwn(catalog, 'cli.renamed')).toBe(false);
  });

  it('no message tells a person to run the old command', () => {
    const catalog = json('platform/packages/messages/src/locales/en.json') as Record<
      string,
      string
    >;
    // `sdlc:intent=` is the machine marker of the platform's GitHub comments, not a command.
    const oldCommand = /(?:^|[\s`(])(?:pnpm )?sdlc(?=[ :`])(?!:intent=)/;
    const found = Object.entries(catalog).filter(([, text]) => oldCommand.test(text));
    expect(found.map(([key]) => key)).toEqual([]);
    expect(t('cli.help.overview')).toMatch(/^adlc: /);
  });
});
