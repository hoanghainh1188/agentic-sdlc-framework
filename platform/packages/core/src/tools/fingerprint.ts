// The tools of an evaluation fingerprint (ADR-M86 §2.1, extended by X04, ADR-M69 §2.3): each
// register tool (`tool:<key>`) is replaced by its key, its version and its image digest, so a new
// tool version makes an earlier evaluation "changed" for the agent's approval. A list of built-in
// tools only is unchanged, so its `toolsSha256` stays the same as before X04.
import { isRegisterToolCode, toolKeyOf } from '@sdlc/contracts';

import type { TenantScope } from '../db/tenant-scope.js';

/** `tool:<key>@<version>@<digest or none>` for each register tool; other tools as they are. */
export async function toolsForFingerprint(
  scope: TenantScope,
  tools: readonly string[],
): Promise<string[]> {
  const keys = tools.filter(isRegisterToolCode).map(toolKeyOf);
  if (keys.length === 0) return [...tools];
  const byKey = new Map((await scope.tools.listByKeys(keys)).map((t) => [t.tool_key, t]));
  return tools.map((tool) => {
    if (!isRegisterToolCode(tool)) return tool;
    const found = byKey.get(toolKeyOf(tool));
    return found ? `${tool}@${found.version}@${found.image_digest ?? 'none'}` : tool;
  });
}
