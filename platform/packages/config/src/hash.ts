// `config_hash` (design/D-05 section 6.1, D-08 A05 AC3): SHA-256 of the RFC 8785 canonical JSON of
// the effective configuration (defaults merged, validated). Comments, whitespace, key order and
// values that only repeat a default do not change it.
import { createHash } from 'node:crypto';

import type { ProjectConfig } from '@sdlc/contracts';

import { canonicalJson } from './canonical-json.js';

export function computeConfigHash(config: ProjectConfig): string {
  return createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
}
