// The next-step hint (task V10 AC2): after a command that moves an intent, one line with the
// advice of `adlc next` for the signed-in person. Two reads (`GET /v1/me`, `GET /v1/intents/:intent`),
// never in `--json`, never a reason for the command to fail: any error leaves the hint out.
import type { ApiClient } from '../../api/client.js';
import { intentDetailSchema, meSchema } from '../../api/schemas.js';
import { segment } from '../../api/session.js';
import type { CliContext } from '../../context.js';
import { say } from '../../output.js';
import { adviceText } from '../next.js';
import { adviseNext } from './advice.js';

export async function sayNextHint(
  ctx: CliContext,
  client: ApiClient,
  intentCode: string,
  json: boolean,
): Promise<void> {
  if (json) return;
  try {
    const [me, intent] = await Promise.all([
      client.get('/v1/me', meSchema),
      client.get(`/v1/intents/${segment(intentCode)}`, intentDetailSchema),
    ]);
    say(ctx, 'cli.hint.next', { text: adviceText(adviseNext(intent, me)), intent: intent.code });
  } catch {
    // The command itself succeeded; a missing hint is not an error.
  }
}
