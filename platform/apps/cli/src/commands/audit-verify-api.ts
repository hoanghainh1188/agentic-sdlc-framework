// `sdlc audit verify` through the API (task B13 AC5, D-02 FR-41, ADR-M37 §2.8): the caller's
// tenant chain, for tenant admins. Exit 1 when the chain is broken. The operator's check of every
// tenant on the server is `sdlc ops audit verify`.
import { t } from '@sdlc/messages';

import { chainSchema } from '../api/schemas.js';
import { parseCommand, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, toJson } from '../output.js';
import { REASON_KEYS } from './audit-verify.js';

export async function runAuditVerify(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {});
  if (!parsed) {
    ctx.stderr(t('cli.audit.usage'));
    return EXIT.usage;
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const chain = await client.get('/v1/admin/audit/verify', chainSchema);
    if (json) ctx.stdout(toJson(chain));
    else if (chain.broken) {
      say(ctx, 'audit.verify.broken', {
        tenant: chain.tenant_id,
        seq: chain.broken.seq,
        reason: t(REASON_KEYS[chain.broken.reason]),
        count: chain.checked,
      });
    } else {
      say(ctx, 'audit.verify.intact', { tenant: chain.tenant_id, count: chain.checked });
    }
    return chain.ok ? EXIT.ok : EXIT.failed;
  });
}
