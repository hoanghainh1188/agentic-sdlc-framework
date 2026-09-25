// The spike is not part of the product: nothing in apps/ or packages/ may import it.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const PLATFORM = path.resolve(import.meta.dirname, '../../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|mts|cts|js|mjs|json)$/.test(entry.name) ? [full] : [];
  });
}

describe('spike isolation', () => {
  it('no file under platform/apps or platform/packages refers to platform/spikes', () => {
    const offenders = ['apps', 'packages']
      .flatMap((d) => sourceFiles(path.join(PLATFORM, d)))
      .filter((file) => /spikes\//.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
