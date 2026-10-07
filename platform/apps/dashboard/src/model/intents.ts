// The intents board (U01 AC4): open intents in lanes by gate, the longest wait first, with who the
// gate is decided by (`waiting_for`, as the workflow resolves it, QUESTIONS #261).
import type { EscalationView, IntentView } from '@sdlc/api-schemas';

import { secondsSince } from './time.js';

export const GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'] as const;
export type Gate = (typeof GATES)[number];

export const FINISHED_STATUSES: readonly string[] = ['done', 'rejected', 'cancelled', 'blocked'];

export function isOpen(intent: Pick<IntentView, 'status'>): boolean {
  return !FINISHED_STATUSES.includes(intent.status);
}

/** A lane: `draft`, one per gate, in the order of the workflow. */
export type LaneId = 'draft' | Gate;

export interface BoardCard {
  readonly intent: IntentView;
  /** Seconds since the intent entered its current gate; null in `draft` or before B07 kept it. */
  readonly waitedSeconds: number | null;
  /** An open escalation of the intent with the trigger `time`: its gate is past its deadline. */
  readonly overdue: boolean;
  /** An open escalation of the intent freezes it (`freezes_intent`, from the API). */
  readonly frozen: boolean;
}

export interface Lane {
  readonly id: LaneId;
  readonly cards: readonly BoardCard[];
}

function laneOf(intent: IntentView): LaneId {
  const gate = intent.current_gate;
  return gate !== null && (GATES as readonly string[]).includes(gate) ? (gate as Gate) : 'draft';
}

const OPEN_ESCALATION = ['open', 'acknowledged'];

/** Builds the lanes; finished intents stay off the board. Every lane is present, maybe empty. */
export function buildBoard(
  intents: readonly IntentView[],
  escalations: readonly EscalationView[],
  now: Date,
): readonly Lane[] {
  const open = escalations.filter((e) => OPEN_ESCALATION.includes(e.status));
  const cards = intents.filter(isOpen).map((intent): BoardCard => ({
    intent,
    waitedSeconds: intent.status === 'draft' ? null : secondsSince(intent.gate_entered_at, now),
    overdue: open.some((e) => e.intent.id === intent.id && e.trigger === 'time'),
    frozen: open.some((e) => e.intent.id === intent.id && e.freezes_intent),
  }));
  const order: readonly LaneId[] = ['draft', ...GATES];
  return order.map((id) => ({
    id,
    cards: cards
      .filter((card) => laneOf(card.intent) === id)
      .sort((a, b) => (b.waitedSeconds ?? -1) - (a.waitedSeconds ?? -1)),
  }));
}

/** The longest wait on the board, to scale every card's wait bar against. */
export function longestWait(lanes: readonly Lane[]): number {
  return Math.max(0, ...lanes.flatMap((l) => l.cards.map((c) => c.waitedSeconds ?? 0)));
}

/** Where each gate stands for one intent: passed, current, or ahead. */
export type GateState = 'passed' | 'current' | 'ahead';

export function gateTrack(intent: Pick<IntentView, 'current_gate' | 'status'>): readonly {
  readonly gate: Gate;
  readonly state: GateState;
}[] {
  const at = intent.current_gate === null ? -1 : GATES.indexOf(intent.current_gate as Gate);
  const done = intent.status === 'done';
  return GATES.map((gate, i) => ({
    gate,
    state: done || i < at ? 'passed' : i === at ? 'current' : 'ahead',
  }));
}

/** GitHub links of an intent; null when the repository name is not a plain `owner/name`. */
export function intentLinks(intent: Pick<IntentView, 'project' | 'issue_number' | 'pr_number'>): {
  readonly issue: string | null;
  readonly pullRequest: string | null;
} {
  const repo = intent.project.repo_full_name;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..')) {
    return { issue: null, pullRequest: null };
  }
  const base = `https://github.com/${repo}`;
  return {
    issue: intent.issue_number === null ? null : `${base}/issues/${intent.issue_number}`,
    pullRequest: intent.pr_number === null ? null : `${base}/pull/${intent.pr_number}`,
  };
}
