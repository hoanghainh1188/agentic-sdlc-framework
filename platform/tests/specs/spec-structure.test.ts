// S01 (D-08 S01 AC1, AC5, ADR-M61, QUESTIONS #290–#292): the structure of a spec and its
// acceptance criteria, for the pinned formats of Spec Kit v1.1.2 and BMAD v6.12.1, the manual
// heading rule (D-09 §8), and the pilot's specs.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACCEPTANCE_CRITERIA_MAX, readSpecStructure } from '../../packages/core/src/specs/index.js';

const FIXTURES = join(__dirname, 'fixtures');
const PILOT = join(__dirname, '../integration/pilot/fixtures/docs/specs');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

describe('readSpecStructure: the pinned tool formats', () => {
  it('Spec Kit: counts the Acceptance Scenarios only, never FR-xxx or SC-xxx (#291)', () => {
    expect(readSpecStructure(fixture('spec-kit-filled.md'), 'spec-kit')).toEqual({
      structure: 'spec_kit',
      acceptanceCriteria: 3,
    });
  });

  it('Spec Kit: an unfilled template has no criterion', () => {
    expect(readSpecStructure(fixture('spec-kit-template.md'), 'spec-kit')).toEqual({
      structure: 'spec_kit',
      acceptanceCriteria: 0,
    });
  });

  it('BMAD story file: the items of ## Acceptance Criteria', () => {
    expect(readSpecStructure(fixture('bmad-story-filled.md'), 'bmad')).toEqual({
      structure: 'bmad_story',
      acceptanceCriteria: 3,
    });
    expect(readSpecStructure(fixture('bmad-story-template.md'), 'bmad')).toEqual({
      structure: 'bmad_story',
      acceptanceCriteria: 0,
    });
  });

  it('BMAD epics file: each **Given** group of the **Acceptance Criteria:** blocks', () => {
    expect(readSpecStructure(fixture('bmad-epics-filled.md'), 'bmad')).toEqual({
      structure: 'bmad_epics',
      acceptanceCriteria: 3,
    });
    expect(readSpecStructure(fixture('bmad-epics-template.md'), 'bmad')).toEqual({
      structure: 'bmad_epics',
      acceptanceCriteria: 0,
    });
  });

  it('falls back to the other rules when the tool is wrong or not given', () => {
    expect(readSpecStructure(fixture('spec-kit-filled.md'), null)).toEqual({
      structure: 'spec_kit',
      acceptanceCriteria: 3,
    });
    expect(readSpecStructure(fixture('bmad-epics-filled.md'), 'manual')).toEqual({
      structure: 'bmad_epics',
      acceptanceCriteria: 3,
    });
    // A BMAD story read as manual: its heading matches the manual rule.
    expect(readSpecStructure(fixture('bmad-story-filled.md'), null)).toEqual({
      structure: 'manual_heading',
      acceptanceCriteria: 3,
    });
    expect(readSpecStructure(fixture('manual-no-criteria.md'), 'spec-kit')).toEqual({
      structure: 'none',
      acceptanceCriteria: 0,
    });
  });
});

describe('readSpecStructure: the manual heading rule', () => {
  const read = (text: string) => readSpecStructure(text, 'manual');

  it('the bilingual heading of D-09 §8, the top-level items only', () => {
    const text = [
      '# T06 消費税計算 / Consumption tax calculation',
      '## 受入基準 / Acceptance criteria',
      '- AC1: 商品に税区分を持たせる。',
      '        Each product has a tax category.',
      '  - a nested note',
      '- AC2: 税率ごとに合計する。',
      '- AC3: 税込を表示する。',
      '## 対象外 / Out of scope',
      '- インボイス番号の出力',
    ].join('\n');
    expect(read(text)).toEqual({ structure: 'manual_heading', acceptanceCriteria: 3 });
  });

  it('English or Japanese alone, any case, numbered lists, CRLF and a BOM', () => {
    expect(read('\uFEFF## ACCEPTANCE CRITERIA\r\n1. one\r\n2) two\r\n')).toEqual({
      structure: 'manual_heading',
      acceptanceCriteria: 2,
    });
    expect(read('### 受入基準\n* 一つ目\n+ 二つ目\n')).toEqual({
      structure: 'manual_heading',
      acceptanceCriteria: 2,
    });
  });

  it('the section ends at a heading of the same or a higher level, not a lower one', () => {
    const text = '## Acceptance criteria\n- a\n### Details\n- b\n## Notes\n- c\n';
    expect(read(text).acceptanceCriteria).toBe(2);
  });

  it('a heading with no items, empty items and placeholders count 0', () => {
    expect(read('## Acceptance criteria\n\nTo be written.\n')).toEqual({
      structure: 'manual_heading',
      acceptanceCriteria: 0,
    });
    expect(read('## Acceptance criteria\n- \n- [TBD]\n- {{criterion}}\n').acceptanceCriteria).toBe(
      0,
    );
  });

  it('links, checkboxes and code are real text, not placeholders', () => {
    const text = [
      '## Acceptance criteria',
      '- [ ] The [order API](https://example.invalid/api) pages',
      '- [x] `GET /orders?page=2` returns page 2',
      '- AC3: SKU の形式（正規表現 `^[A-Z]{3}-[0-9]{3}$`）', // the pilot's T02 AC1
      '- `[placeholder]` in code',
    ].join('\n');
    expect(read(text).acceptanceCriteria).toBe(4);
  });

  it('skips fenced code blocks and HTML comments', () => {
    const text = [
      '```markdown',
      '## Acceptance criteria',
      '- inside a fence',
      '```',
      '<!--',
      '## Acceptance criteria',
      '- inside a comment',
      '-->',
      'No criteria here.',
    ].join('\n');
    expect(read(text)).toEqual({ structure: 'none', acceptanceCriteria: 0 });
  });

  it('caps the count at ACCEPTANCE_CRITERIA_MAX', () => {
    const text = `## Acceptance criteria\n${'- c\n'.repeat(ACCEPTANCE_CRITERIA_MAX + 5)}`;
    expect(read(text).acceptanceCriteria).toBe(ACCEPTANCE_CRITERIA_MAX);
  });
});

describe('the pilot specs (D-09 §7)', () => {
  const files = readdirSync(PILOT).filter((name) => name.endsWith('.md'));

  it.each(files)('%s has acceptance criteria (manual heading)', (name) => {
    const read = readSpecStructure(readFileSync(join(PILOT, name), 'utf8'), 'manual');
    expect(read.structure).toBe('manual_heading');
    expect(read.acceptanceCriteria).toBeGreaterThan(0);
  });
});
