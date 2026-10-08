// A plan draft from a BMAD story file (task S02, ADR-M62 §2.1; BMAD Method v6.12.1,
// `src/bmm-skills/v6-shims/bmad-create-story/template.md`, ADR-M61 §2.2). The format:
//
//   ## Tasks / Subtasks
//   - [ ] Add the label map (AC: 1, 2)
//     - [ ] Use the Japanese labels of the spec
//
// One plan task per top-level item (`Task1`, `Task2`, …), the item as the summary and its
// subtasks in `definition_of_done`. BMAD names no dependencies between tasks, so none are written.
// An epics file (`## Epic N:`, `### Story N.M:`) is refused: one intent is one story
// (QUESTIONS #296).
import { isFilledItem, markdownLines, type MarkdownLine } from '../../specs/structure.js';
import { PLAN_MAX_TASKS } from '../rules.js';
import { draftText } from './text.js';
import { DRAFT_LIST_MAX_ITEMS, type DraftRead, type DraftTask } from './types.js';

const TASKS_HEADING = /^tasks(?:\s*\/\s*subtasks)?$/i;
const LIST_ITEM = /^([ \t]*)[-*+][ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/;
const EPIC_HEADING = /^Epic\s+\d+\s*:/i;
const STORY_HEADING = /^Story\s+\d+\.\d+\s*:/i;
/** The story template's sample tasks (`Task 1 (AC: #)`, `Subtask 1.1`). */
const BMAD_SAMPLE = /\(AC:\s*#\s*\)|^(?:Sub)?task\s+\d+(?:\.\d+)?$/i;

interface Item {
  readonly text: string;
  readonly subtasks: string[];
}

export function readBmadStory(text: string): DraftRead {
  const lines = markdownLines(text);
  const start = lines.findIndex(
    (line) => line.heading === 2 && TASKS_HEADING.test(line.headingText),
  );
  if (start < 0) {
    const epics = lines.some(
      (line) =>
        (line.heading === 2 && EPIC_HEADING.test(line.headingText)) ||
        (line.heading === 3 && STORY_HEADING.test(line.headingText)),
    );
    return { ok: false, refusal: epics ? 'epics_file' : 'no_tasks' };
  }
  const items = readItems(section(lines, start));
  if (items.length === 0) return { ok: false, refusal: 'no_tasks' };
  const texts = items.flatMap((item) => [item.text, ...item.subtasks]);
  if (texts.some((t) => !isFilledItem(t) || BMAD_SAMPLE.test(t.trim()))) {
    return { ok: false, refusal: 'template_text' };
  }
  if (items.length > PLAN_MAX_TASKS) return { ok: false, refusal: 'too_many_tasks' };
  const tasks = items.map((item, index): DraftTask => ({
    id: `Task${index + 1}`,
    summary: draftText(item.text),
    dependsOn: [],
    definitionOfDone: item.subtasks
      .map(draftText)
      .filter((v) => v.length > 0)
      .slice(0, DRAFT_LIST_MAX_ITEMS),
    // BMAD stories name no reliable paths: the person writes them (ADR-M62 §2.2).
    pathHints: [],
  }));
  return { ok: true, tasks, grouped: false };
}

function section(lines: readonly MarkdownLine[], start: number): MarkdownLine[] {
  const out: MarkdownLine[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.heading > 0 && line.heading <= 2) break;
    out.push(line);
  }
  return out;
}

/** Top-level items (the smallest indent) and the deeper items under them. */
function readItems(block: readonly MarkdownLine[]): Item[] {
  const found: { indent: number; text: string }[] = [];
  for (const line of block) {
    const match = LIST_ITEM.exec(line.text);
    if (match) found.push({ indent: match[1]!.replace(/\t/g, '    ').length, text: match[2]! });
  }
  if (found.length === 0) return [];
  const top = Math.min(...found.map((item) => item.indent));
  const items: Item[] = [];
  for (const entry of found) {
    if (entry.indent === top) items.push({ text: entry.text, subtasks: [] });
    else items.at(-1)?.subtasks.push(entry.text);
  }
  return items;
}
