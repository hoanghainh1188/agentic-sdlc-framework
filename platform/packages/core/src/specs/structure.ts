// The structure of a spec and its acceptance criteria (task S01, D-08 S01 AC1–AC2, D-02 §6.2 G2
// "Acceptance criteria present", design/ADR-M61, QUESTIONS #290–#292).
//
// The counter reads the spec's text in memory, in the same call that hashes it (`readSpec`), and
// returns a count and a structure code only: the text is client data and never leaves this module
// (no table, log, event or Temporal input holds it).
//
// What counts as one acceptance criterion, by the spec's `source_tool` (the formats of the pinned
// versions in ADR-M61):
// - `spec-kit` (Spec Kit v1.1.2, `templates/spec-template.md`): each top-level list item of an
//   `**Acceptance Scenarios**:` block. `FR-xxx` and `SC-xxx` items are requirements and success
//   criteria, not acceptance criteria (QUESTIONS #291).
// - `bmad` (BMAD Method v6.12.1): a story file's `## Acceptance Criteria` section (each top-level
//   list item), or an epics file's `**Acceptance Criteria:**` blocks (each `**Given**` group; a
//   block without one counts its list items).
// - `manual`, or no tool: each top-level list item under a heading that contains "acceptance
//   criteria" (any case) or 受入基準, such as `## 受入基準 / Acceptance criteria` (D-09 §8), up to
//   the next heading of the same or a higher level.
// A structure the tool's rule does not find falls back to the other rules (manual first), so a
// spec linked with the wrong tool or none is still read; the structure code says which rule
// matched. Template text that was never filled in (`[initial state]`, `{{precondition}}`) and empty
// items do not count, so an unfilled template never passes G2. Fenced code blocks and HTML
// comments are skipped.
import {
  ACCEPTANCE_CRITERIA_MAX,
  SPEC_STRUCTURES,
  type SpecSourceTool,
  type SpecStructureCode,
} from '../db/vocabulary.js';

export { ACCEPTANCE_CRITERIA_MAX, SPEC_STRUCTURES, type SpecStructureCode };

export interface SpecStructure {
  readonly structure: SpecStructureCode;
  /** Acceptance criteria found; 0 when the rule matched but found none, or nothing matched. */
  readonly acceptanceCriteria: number;
}

interface Line {
  readonly text: string;
  /** Heading level 1–6, or 0. */
  readonly heading: number;
  readonly headingText: string;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const SPEC_KIT_MARKER = /^\s*\*\*Acceptance Scenarios\*\*\s*:?\s*$/i;
const BMAD_EPICS_MARKER = /^\s*\*\*Acceptance Criteria:?\*\*\s*:?\s*$/i;
const BOLD_LABEL = /^\s*\*\*[^*]+\*\*\s*:?/;
const GIVEN = /^\s*(?:[-*+][ \t]+)?\*\*Given\*\*/i;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** The structure and the number of acceptance criteria of a spec's Markdown text. */
export function readSpecStructure(text: string, tool: SpecSourceTool | null): SpecStructure {
  const lines = toLines(text);
  for (const rule of rulesFor(tool)) {
    const found = rule(lines);
    if (found) return { ...found, acceptanceCriteria: cap(found.acceptanceCriteria) };
  }
  return { structure: 'none', acceptanceCriteria: 0 };
}

type Rule = (lines: readonly Line[]) => SpecStructure | null;

function rulesFor(tool: SpecSourceTool | null): readonly Rule[] {
  switch (tool) {
    case 'spec-kit':
      return [specKit, manualHeading, bmadEpics];
    case 'bmad':
      return [bmadEpics, bmadStory, manualHeading, specKit];
    default:
      return [manualHeading, specKit, bmadEpics];
  }
}

function cap(count: number): number {
  return Math.min(count, ACCEPTANCE_CRITERIA_MAX);
}

/** The lines outside fenced code blocks and HTML comments, with their heading level. */
function toLines(text: string): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  let comment = false;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n|\r/)) {
    if (fence !== null) {
      if (raw.trim().startsWith(fence)) fence = null;
      continue;
    }
    const opening = FENCE.exec(raw);
    if (opening && !comment) {
      fence = opening[1]!.slice(0, 3);
      continue;
    }
    const line = stripComments(raw, comment);
    comment = line.open;
    const heading = HEADING.exec(line.text);
    out.push({
      text: line.text,
      heading: heading ? heading[1]!.length : 0,
      headingText: heading ? (heading[2] ?? '').trim() : '',
    });
  }
  return out;
}

/** Removes `<!-- … -->` comments, also across lines (`open`: a comment goes on to the next line). */
function stripComments(raw: string, inComment: boolean): { text: string; open: boolean } {
  let text = '';
  let rest = raw;
  if (inComment) {
    const end = rest.indexOf('-->');
    if (end < 0) return { text, open: true };
    rest = rest.slice(end + 3);
  }
  for (;;) {
    const start = rest.indexOf('<!--');
    if (start < 0) return { text: text + rest, open: false };
    text += rest.slice(0, start);
    const end = rest.indexOf('-->', start + 4);
    if (end < 0) return { text, open: true };
    rest = rest.slice(end + 3);
  }
}

/** True for an item that holds real text: not empty, not a template placeholder. */
function filled(itemText: string): boolean {
  const text = itemText
    .replace(/^\[[ xX]\][ \t]+/, '') // a task list checkbox
    .replace(/(`+)[^`]*?\1/g, 'code') // inline code: `^[A-Z]{3}$` is text, not a placeholder
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, '') // Markdown links and images
    .replace(/\[[^\]]*\]\[[^\]]*\]/g, '') // reference links
    .trim();
  if (text.length === 0) return false;
  if (text.includes('{{')) return false;
  return !/\[[^\]]*\p{L}[^\]]*\]/u.test(text);
}

/** The top-level list items of a block: the items with the smallest indent. */
function countItems(block: readonly Line[]): number {
  const items: { indent: number; text: string }[] = [];
  for (const line of block) {
    const match = LIST_ITEM.exec(line.text);
    if (match) items.push({ indent: indentWidth(match[1]!), text: match[2]! });
  }
  if (items.length === 0) return 0;
  const top = Math.min(...items.map((item) => item.indent));
  return items.filter((item) => item.indent === top && filled(item.text)).length;
}

function indentWidth(indent: string): number {
  return indent.replace(/\t/g, '    ').length;
}

/** The lines after `start` up to (not including) a heading of level `level` or higher. */
function section(lines: readonly Line[], start: number, level: number): Line[] {
  const out: Line[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.heading > 0 && line.heading <= level) break;
    out.push(line);
  }
  return out;
}

/** The lines after a bold marker up to the next heading, bold label or thematic break. */
function markerBlock(lines: readonly Line[], start: number): Line[] {
  const out: Line[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.heading > 0 || RULE.test(line.text)) break;
    if (BOLD_LABEL.test(line.text) && !GIVEN.test(line.text) && !isAndThen(line.text)) break;
    out.push(line);
  }
  return out;
}

/** `**When**`, `**Then**`, `**And**`, `**But**`: the lines of a Given group. */
function isAndThen(text: string): boolean {
  return /^\s*(?:[-*+][ \t]+)?\*\*(?:When|Then|And|But)\*\*/i.test(text);
}

const manualHeading: Rule = (lines) => {
  let found = false;
  let count = 0;
  lines.forEach((line, i) => {
    if (line.heading === 0) return;
    const title = line.headingText.toLowerCase();
    if (!title.includes('acceptance criteria') && !line.headingText.includes('受入基準')) return;
    found = true;
    count += countItems(section(lines, i, line.heading));
  });
  return found ? { structure: 'manual_heading', acceptanceCriteria: count } : null;
};

const specKit: Rule = (lines) => {
  let found = false;
  let count = 0;
  lines.forEach((line, i) => {
    if (!SPEC_KIT_MARKER.test(line.text)) return;
    found = true;
    count += countItems(markerBlock(lines, i));
  });
  return found ? { structure: 'spec_kit', acceptanceCriteria: count } : null;
};

const bmadEpics: Rule = (lines) => {
  let found = false;
  let count = 0;
  lines.forEach((line, i) => {
    if (!BMAD_EPICS_MARKER.test(line.text)) return;
    found = true;
    const block = markerBlock(lines, i);
    const givens = block.filter((l) => GIVEN.test(l.text) && filled(givenText(l.text)));
    count += givens.length > 0 ? givens.length : countItems(block);
  });
  return found ? { structure: 'bmad_epics', acceptanceCriteria: count } : null;
};

function givenText(text: string): string {
  return text.replace(GIVEN, '');
}

const bmadStory: Rule = (lines) => {
  let found = false;
  let count = 0;
  lines.forEach((line, i) => {
    if (line.heading !== 2 || line.headingText.toLowerCase() !== 'acceptance criteria') return;
    found = true;
    count += countItems(section(lines, i, line.heading));
  });
  return found ? { structure: 'bmad_story', acceptanceCriteria: count } : null;
};
