// Response bodies of the spec endpoints (task B08, ADR-M39 §2.2): the path, commit and SHA-256 of
// each version, never the content. The CLI checks them with its own schemas (api-schemas test).
import type { SpecRef } from '@sdlc/core';

import { presentSpec } from '../intents/present.js';

export function presentLinkedSpec(intentCode: string, spec: SpecRef): Record<string, unknown> {
  return { intent: intentCode, ...presentSpec(spec) };
}

export function presentSpecList(
  intentCode: string,
  specs: readonly SpecRef[],
): Record<string, unknown> {
  return { intent: intentCode, items: specs.map((spec) => presentSpec(spec)) };
}
