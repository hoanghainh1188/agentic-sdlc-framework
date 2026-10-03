// CI maintenance: `pnpm diagrams:check` (scripts/diagrams.py check). Every Mermaid source has an SVG,
// every SVG has a source, each SVG carries the SHA-256 of its source on its first line and is
// well-formed XML with an <svg> root. The committed diagrams must pass; each fault must fail.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { repoRoot } from './helpers';

const root = repoRoot();
const script = path.join(root, 'scripts/diagrams.py');
const SOURCE = 'flowchart LR\n  A --> B\n';
const BODY = '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function check(dir?: string): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: '', DIAGRAMS_ROOT: dir ?? '' };
  const result = spawnSync('python3', [script, 'check'], { env, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throw-away repository root with one source `d1` and a matching SVG, then `edit` applied. */
function fixture(edit: (src: string, svg: string) => void = () => undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagrams-'));
  dirs.push(dir);
  const src = path.join(dir, 'diagrams/src');
  const svg = path.join(dir, 'diagrams/svg');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(svg, { recursive: true });
  fs.writeFileSync(path.join(src, 'd1.mmd'), SOURCE);
  fs.writeFileSync(path.join(svg, 'd1.svg'), `<!-- source-sha256: ${sha256(SOURCE)} -->\n${BODY}`);
  edit(src, svg);
  return dir;
}

describe('pnpm diagrams:check', () => {
  it('passes on the committed diagrams', () => {
    const result = check();
    expect(result.output).toContain('every SVG matches its source');
    expect(result.status).toBe(0);
  });

  it('passes on a matching source and SVG', () => {
    expect(check(fixture()).status).toBe(0);
  });

  it.each([
    [
      'a changed source',
      (src: string) => fs.appendFileSync(path.join(src, 'd1.mmd'), '  B --> C\n'),
      'd1.svg is stale',
    ],
    [
      'a source without an SVG',
      (src: string) => fs.writeFileSync(path.join(src, 'd2.mmd'), SOURCE),
      'd2.mmd has no SVG',
    ],
    [
      'an SVG without a source',
      (_src: string, svg: string) =>
        fs.copyFileSync(path.join(svg, 'd1.svg'), path.join(svg, 'd2.svg')),
      'd2.svg has no source',
    ],
    [
      'an SVG without the stamp',
      (_src: string, svg: string) => fs.writeFileSync(path.join(svg, 'd1.svg'), BODY),
      'no source-sha256 stamp',
    ],
    [
      'an SVG that is not well-formed',
      (_src: string, svg: string) =>
        fs.writeFileSync(
          path.join(svg, 'd1.svg'),
          `<!-- source-sha256: ${sha256(SOURCE)} -->\n<svg xmlns="http://www.w3.org/2000/svg"><g></svg>`,
        ),
      'not well-formed XML',
    ],
    [
      'an XML file whose root is not <svg>',
      (_src: string, svg: string) =>
        fs.writeFileSync(
          path.join(svg, 'd1.svg'),
          `<!-- source-sha256: ${sha256(SOURCE)} -->\n<html/>`,
        ),
      'root element is not <svg>',
    ],
  ])('fails on %s', (_name, edit, message) => {
    const result = check(fixture(edit));
    expect(result.status).toBe(1);
    expect(result.output).toContain(message);
    expect(result.output).toContain('pnpm diagrams:render');
  });
});
