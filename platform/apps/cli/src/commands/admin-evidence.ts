// `sdlc admin evidence hold|release|show <INT-…>` through the API (task E05, design/ADR-M51,
// QUESTIONS #235; handbook Ch.15, Ch.19 §19.8d). A hold keeps an intent's evidence files from the
// retention purge until it is released. Who: tenant admins, or a role in config
// `access.evidence_hold_roles` (default governance and admin; never viewer, rule M32).
import {
  evidenceHoldChangeSchema,
  evidenceHoldListSchema,
  type EvidenceHoldView,
} from '../api/schemas.js';
import { segment } from '../api/session.js';
import { clean, say } from '../output.js';
import { opt, output, type AdminApiCommand, type AdminCall } from './admin-call.js';

const holdPath = (call: AdminCall): string =>
  `/v1/intents/${segment(call.positionals[0] ?? '')}/evidence-hold`;

function holdParams(call: AdminCall, hold: EvidenceHoldView): Record<string, string> {
  return {
    intent: clean(call.positionals[0] ?? ''),
    id: clean(hold.id),
    created_at: clean(hold.created_at),
    released_at: clean(hold.released_at ?? '-'),
    ref: clean(hold.reason_ref ?? '-'),
  };
}

export const EVIDENCE_HOLD_COMMANDS: Readonly<Record<string, AdminApiCommand>> = {
  'evidence hold': {
    options: { ref: { type: 'string' } },
    required: [],
    positionals: 1,
    run: async (call) => {
      const ref = opt(call.values, 'ref');
      const answer = await call.client.put(holdPath(call), evidenceHoldChangeSchema, {
        ...(ref === undefined ? {} : { reason_ref: ref }),
      });
      return output(call, answer, () =>
        say(call.ctx, 'cli.admin.evidence.held', holdParams(call, answer.hold)),
      );
    },
  },
  'evidence release': {
    options: {},
    required: [],
    positionals: 1,
    run: async (call) => {
      const answer = await call.client.delete(holdPath(call), evidenceHoldChangeSchema);
      return output(call, answer, () =>
        say(call.ctx, 'cli.admin.evidence.released', holdParams(call, answer.hold)),
      );
    },
  },
  'evidence show': {
    options: {},
    required: [],
    positionals: 1,
    run: async (call) => {
      const view = await call.client.get(holdPath(call), evidenceHoldListSchema);
      return output(call, view, () => {
        if (view.active) say(call.ctx, 'cli.admin.evidence.active', holdParams(call, view.active));
        else say(call.ctx, 'cli.admin.evidence.not_held', { intent: clean(view.intent) });
        for (const hold of view.history) {
          say(call.ctx, 'cli.admin.evidence.line', holdParams(call, hold));
        }
      });
    },
  },
};
