// The admin actor of a request: always the authenticated person (task B13). The operator acts
// through the operator commands on the server, never through the API.
import type { AdminActor } from '@sdlc/core';

import type { Principal } from '../auth/principal.js';

export function actorOf(p: Principal): AdminActor & { readonly type: 'human' } {
  return { type: 'human', userId: p.userId };
}
