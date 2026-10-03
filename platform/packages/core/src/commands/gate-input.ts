// The input a gate decision is bound to (D-02 FR-17, D-03 section 6.3; task B03, QUESTIONS.md #64,
// ADR-M26 section 2.4). The platform computes it from the registry; a client never sends a hash.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import type { GateCode } from '@sdlc/contracts';

import type { Intent } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { latestRunProposalSha256 } from '../workflow/g4-proposal.js';
import { gatherG5Facts } from '../workflow/g5-facts.js';
import { CommandError } from './errors.js';

/**
 * The gates of the intent's path before the run (B03, B07): moved on people's decisions or a HOTL
 * pass. G4 is a policy gate that people decide only when it is HITL (C06, `DECIDABLE_GATES`).
 */
export const COMMAND_GATES = ['G1', 'G2', 'G3'] as const satisfies readonly GateCode[];
export type CommandGate = (typeof COMMAND_GATES)[number];

export function isCommandGate(gate: string): gate is CommandGate {
  return (COMMAND_GATES as readonly string[]).includes(gate);
}

/**
 * Gates a person may decide by a command: G1–G3, G4 (C06: Person A approves the run proposal at
 * High risk, ADR-M33 §2.4) and G5 (C07, ADR-M34 §2.8: Person A approves the run's changes where
 * G5 is HITL, or blocks a G5 the platform passed within its block window). G6 is a system gate;
 * E01 and E03 add G7 and G8.
 */
export const DECIDABLE_GATES = [
  ...COMMAND_GATES,
  'G4',
  'G5',
] as const satisfies readonly GateCode[];
export type DecidableGate = (typeof DECIDABLE_GATES)[number];

export function isDecidableGate(gate: string): gate is DecidableGate {
  return (DECIDABLE_GATES as readonly string[]).includes(gate);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * G1 input: the intent fields that G1 approves (goal, scope, risk). Version 1 of this list; any
 * change to it changes every G1 hash, so add a version field before changing it.
 */
export function intentInputSha256(intent: Intent): string {
  return sha256(
    canonicalJson({
      v: 1,
      code: intent.code,
      project_id: intent.project_id,
      risk_tier: intent.risk_tier,
      data_class: intent.data_class,
      budget_usd: intent.budget_usd,
      title_sha256: sha256(intent.title),
      description_sha256: sha256(intent.description),
    }),
  );
}

/**
 * The bound input of a gate: G1 the intent, G2 the latest spec content hash, G3 the latest plan
 * hash, G4 the last run proposal the workflow recorded (C06, ADR-M33 §2.3), G5 the result of the
 * last run (C07, `gatherG5Facts`). Throws `CommandError('gate_input_missing')` when G2 has no spec,
 * G3 no plan, G4 no proposal or G5 no finished run yet.
 */
export async function gateInputSha256(
  scope: TenantScope,
  intent: Intent,
  gate: DecidableGate,
): Promise<string> {
  switch (gate) {
    case 'G5': {
      const facts = await gatherG5Facts(scope, intent.id);
      if (!facts) throw new CommandError('gate_input_missing', `${intent.code}: no run to check`);
      return facts.inputSha256;
    }
    case 'G4': {
      const proposal = await latestRunProposalSha256(scope, intent.id);
      if (!proposal) {
        throw new CommandError('gate_input_missing', `${intent.code}: no run proposal yet`);
      }
      return proposal;
    }
    case 'G1':
      return intentInputSha256(intent);
    case 'G2': {
      const spec = await scope.specRefs.latest(intent.id);
      if (!spec) throw new CommandError('gate_input_missing', `${intent.code}: no spec linked`);
      return spec.content_sha256;
    }
    case 'G3': {
      const plan = await scope.plans.latest(intent.id);
      if (!plan) throw new CommandError('gate_input_missing', `${intent.code}: no plan submitted`);
      return plan.plan_sha256;
    }
  }
}
