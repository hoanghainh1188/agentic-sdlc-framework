// `sdlc gate approve|reject|request-changes <G> <INT>` over the API (D-08 B04 AC1, FR-20;
// ADR-M26 §2.4). Codes and one https link only: the explanation in words stays where it can be
// edited or deleted (a GitHub comment), and `--reason-ref` links to it (ADR-M20). No scope:
// G1–G5 approvals take none (`scope_not_allowed`); E01 and E03 add it for G7 and G8.
import { GATE_CODES, GATE_REASON_CODES } from '@sdlc/contracts';
import { t } from '@sdlc/messages';

import { decisionSchema } from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, toJson } from '../output.js';
import { decisionParams, intentRef } from './intent.js';

const VERBS: Readonly<Record<string, string>> = {
  approve: 'approve',
  reject: 'reject',
  'request-changes': 'request_changes',
};

export const HTTPS_REF = /^https:\/\/[^\s@]{1,504}$/;

export async function runGate(args: readonly string[], ctx: CliContext): Promise<number> {
  const [verb, ...rest] = args;
  const decision = verb === undefined ? undefined : VERBS[verb];
  const parsed = parseCommand(
    rest,
    { 'reason-code': { type: 'string' }, 'reason-ref': { type: 'string' } },
    2,
  );
  const gate = parsed?.positionals[0]?.toUpperCase();
  const ref = parsed ? intentRef(parsed.positionals[1] ?? '') : undefined;
  const reasonCode = parsed?.values['reason-code'];
  const reasonRef = parsed?.values['reason-ref'];
  if (
    decision === undefined ||
    !parsed ||
    gate === undefined ||
    !(GATE_CODES as readonly string[]).includes(gate) ||
    ref === undefined ||
    (typeof reasonCode === 'string' &&
      !(GATE_REASON_CODES as readonly string[]).includes(reasonCode)) ||
    (typeof reasonRef === 'string' && !HTTPS_REF.test(reasonRef))
  ) {
    ctx.stderr(t('cli.gate.usage'));
    return EXIT.usage;
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const row = await client.post(
      `/v1/intents/${segment(ref)}/gates/${segment(gate)}/decisions`,
      decisionSchema,
      {
        decision,
        ...(typeof reasonCode === 'string' ? { reason_code: reasonCode } : {}),
        ...(typeof reasonRef === 'string' ? { reason_ref: reasonRef } : {}),
      },
    );
    if (json) ctx.stdout(toJson(row));
    else say(ctx, 'cli.gate.recorded', { ...decisionParams(row), intent: ref });
    return EXIT.ok;
  });
}
