// The client AI disclosure note of an Evidence Pack (task E02, D-02 FR-43, handbook Ch.2 Rule 6,
// design/ADR-M48 §2.5, QUESTIONS #217). The facts come from the platform's data; the text comes
// from the message catalog in the project's disclosure format (project AI record, ADR-M32):
// - `standard_note`: our standard note, filled with the facts.
// - `client_format`: the same facts, a line that the client's own format applies (the PM/BrSE
//   writes it from the human AI record, `record_ref`), and `client_text_required: true` in the
//   manifest. E03 decides whether G8 needs a person to confirm that note.
import type { DisclosureFormat } from '@sdlc/contracts';
import { t } from '@sdlc/messages';

import type { PackSource } from './manifest.js';

export interface DisclosureFacts {
  readonly format: DisclosureFormat;
  readonly client_text_required: boolean;
  /** The link to the human AI record, for `client_format` only. */
  readonly record_ref: string | null;
  /** `agent_key@version` of every agent that ran, sorted. */
  readonly agents: readonly string[];
  /** Gateway model names known for those runs, sorted. */
  readonly models: readonly string[];
  /** Runs that started (the agent worked in a sandbox). */
  readonly runs_started: number;
  /** G7 approvals of people that no `void` cancelled. */
  readonly g7_approvals: number;
  /** The latest CI result G6 read (`ci_checked.state`), or `none`. */
  readonly ci_state: string;
}

export function disclosureFacts(source: PackSource): DisclosureFacts {
  const started = source.runs.filter((run) => run.started_at !== null);
  const agents = new Set<string>();
  const models = new Set<string>();
  for (const run of started) {
    const agent = source.agents.get(run.agent_id);
    agents.add(`${agent?.agent_key ?? run.agent_id}@${run.agent_version}`);
    if (agent && agent.version === run.agent_version && agent.model_ref)
      models.add(agent.model_ref);
  }
  const voided = new Set(
    source.decisions.flatMap((d) => (d.voids_decision_id ? [d.voids_decision_id] : [])),
  );
  const g7Approvals = source.decisions.filter(
    (d) =>
      d.gate === 'G7' && d.decision === 'approve' && d.actor_type === 'human' && !voided.has(d.id),
  ).length;
  let ciState = 'none';
  for (const run of source.runs) {
    for (const event of source.runEvents.get(run.id) ?? []) {
      if (event.event_type === 'ci_checked' && typeof event.payload.state === 'string') {
        ciState = event.payload.state;
      }
    }
  }
  const format = source.aiRecord.disclosure_format;
  return {
    format,
    client_text_required: format === 'client_format',
    record_ref: format === 'client_format' ? source.aiRecord.record_ref : null,
    agents: [...agents].sort(),
    models: [...models].sort(),
    runs_started: started.length,
    g7_approvals: g7Approvals,
    ci_state: ciState,
  };
}

/**
 * The disclosure note's paragraphs, from the catalog. Values are codes, counts and one link; the
 * caller's `escape` makes them safe for its format (Markdown).
 */
export function disclosureText(
  facts: DisclosureFacts,
  locale: string,
  escape: (value: string) => string = (value) => value,
): string[] {
  const none = t('evidence.md.none', {}, locale);
  const standard = t(
    'evidence.disclosure.standard_note',
    {
      agents: facts.agents.length > 0 ? escape(facts.agents.join(', ')) : none,
      models: facts.models.length > 0 ? escape(facts.models.join(', ')) : none,
      runs: facts.runs_started,
      approvals: facts.g7_approvals,
      ci: escape(facts.ci_state),
    },
    locale,
  );
  if (facts.format !== 'client_format') return [standard];
  return [
    standard,
    t(
      'evidence.disclosure.client_format',
      { record_ref: facts.record_ref ? escape(facts.record_ref) : none },
      locale,
    ),
  ];
}
