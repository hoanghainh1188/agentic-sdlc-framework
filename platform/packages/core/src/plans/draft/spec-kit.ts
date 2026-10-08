// A plan draft from a Spec Kit `tasks.md` (task S02, ADR-M62 §2.1; Spec Kit v1.1.2,
// `templates/tasks-template.md`, ADR-M61 §2.2). The format:
//
//   ## Phase 3: User Story 1 - Title (Priority: P1)
//   - [ ] T012 [P] [US1] Create Entity model in src/models/entity.py
//   - [ ] T014 [US1] Implement Service in src/services/service.py (depends on T012, T013)
//   **Checkpoint**: User Story 1 works on its own
//
// One plan task per item (`T012`), its description as the summary (without the `[P]` and `[USn]`
// markers), `depends_on` from an explicit "(depends on …)" only, and the phase's checkpoint on its
// last task. More than 20 items: one plan task per `##` phase instead, its items in
// `definition_of_done` (QUESTIONS #295).
import { isFilledItem, markdownLines } from '../../specs/structure.js';
import { PLAN_MAX_TASKS } from '../rules.js';
import { draftText, pathHints } from './text.js';
import { DRAFT_LIST_MAX_ITEMS, type DraftRead, type DraftTask } from './types.js';

const ITEM = /^ {0,3}[-*+][ \t]+\[[ xX]\][ \t]+(T\d{1,30})(?=[\s:.,]|$)[ \t:.]*(.*)$/;
const MARKER = /^\[(?:P|US\d{1,9})\][ \t]*/i;
const DEPENDS = /\(depends on ([^)]*)\)/gi;
const TASK_ID = /\bT\d{1,30}\b/g;
const CHECKPOINT = /^\s*\*\*Checkpoint\*\*\s*:?\s*(.*)$/i;
const PHASE_NUMBER = /^Phase\s+(\d{1,9})\b/i;

interface Item {
  readonly id: string;
  readonly text: string;
  readonly dependsOn: readonly string[];
}

interface Phase {
  readonly title: string;
  readonly items: Item[];
  checkpoint?: string;
}

export function readSpecKitTasks(text: string): DraftRead {
  const phases: Phase[] = [{ title: '', items: [] }];
  for (const line of markdownLines(text)) {
    if (line.heading === 2) {
      phases.push({ title: line.headingText, items: [] });
      continue;
    }
    const phase = phases.at(-1)!;
    const checkpoint = CHECKPOINT.exec(line.text);
    if (checkpoint) {
      phase.checkpoint = checkpoint[1]!;
      continue;
    }
    const item = ITEM.exec(line.text);
    if (!item) continue;
    let rest = item[2]!.trim();
    while (MARKER.test(rest)) rest = rest.replace(MARKER, '');
    phase.items.push({ id: item[1]!, text: rest, dependsOn: dependencies(rest) });
  }
  const items = phases.flatMap((phase) => phase.items);
  if (items.length === 0) return { ok: false, refusal: 'no_tasks' };
  if (items.some((item) => !isFilledItem(item.text)))
    return { ok: false, refusal: 'template_text' };
  if (items.length <= PLAN_MAX_TASKS) return { ok: true, tasks: itemTasks(phases), grouped: false };
  const grouped = phases.filter((phase) => phase.items.length > 0);
  if (grouped.length > PLAN_MAX_TASKS) return { ok: false, refusal: 'too_many_tasks' };
  return { ok: true, tasks: phaseTasks(grouped), grouped: true };
}

function dependencies(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(DEPENDS)) {
    for (const id of match[1]!.matchAll(TASK_ID)) ids.add(id[0]);
  }
  return [...ids];
}

function itemTasks(phases: readonly Phase[]): DraftTask[] {
  const known = new Set(phases.flatMap((phase) => phase.items.map((item) => item.id)));
  return phases.flatMap((phase) =>
    phase.items.map((item, index): DraftTask => {
      const last = index === phase.items.length - 1;
      return {
        id: item.id,
        summary: draftText(item.text),
        dependsOn: item.dependsOn.filter((id) => known.has(id) && id !== item.id),
        definitionOfDone: [],
        ...(last && phase.checkpoint ? { checkpoint: draftText(phase.checkpoint) } : {}),
        pathHints: pathHints([item.text]),
      };
    }),
  );
}

/** One task per phase; IDs `Phase3`, or `Group<n>` when the heading has no phase number. */
function phaseTasks(phases: readonly Phase[]): DraftTask[] {
  const ids = phases.map((phase, index) => {
    const number = PHASE_NUMBER.exec(phase.title);
    return number ? `Phase${number[1]}` : `Group${index + 1}`;
  });
  const unique = new Set(ids).size === ids.length;
  const idOf = (index: number): string => (unique ? ids[index]! : `Group${index + 1}`);
  const phaseOfItem = new Map<string, number>();
  phases.forEach((phase, index) => phase.items.forEach((item) => phaseOfItem.set(item.id, index)));
  return phases.map((phase, index): DraftTask => {
    const depends = new Set<string>();
    for (const item of phase.items) {
      for (const dep of item.dependsOn) {
        const other = phaseOfItem.get(dep);
        if (other !== undefined && other !== index) depends.add(idOf(other));
      }
    }
    return {
      id: idOf(index),
      summary: draftText(phase.title || idOf(index)),
      dependsOn: [...depends],
      definitionOfDone: phase.items
        .slice(0, DRAFT_LIST_MAX_ITEMS)
        .map((item) => draftText(`${item.id} ${item.text}`)),
      ...(phase.checkpoint ? { checkpoint: draftText(phase.checkpoint) } : {}),
      pathHints: pathHints(phase.items.map((item) => item.text)),
    };
  });
}
