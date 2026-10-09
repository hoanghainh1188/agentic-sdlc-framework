// The spec link request and its output, shared by `sdlc spec link` (B08) and
// `sdlc intent create --spec` (U03): one validation, one body, one way to print the result.
import { SPEC_SOURCE_TOOLS } from '@sdlc/core';

import { linkedSpecSchema } from '../api/schemas.js';
import type { ApiClient } from '../api/client.js';
import { segment } from '../api/session.js';
import type { CliContext } from '../context.js';
import { say } from '../output.js';

const COMMIT = /^[0-9a-f]{40}$/;
const MAX_PATH = 1024;

export interface SpecLinkInput {
  readonly path: string;
  readonly commit?: string;
  readonly tool?: string;
}

/** The request body, or undefined when an option is malformed (a usage error, no API call). */
export function specLinkBody(input: {
  readonly path: unknown;
  readonly commit: unknown;
  readonly tool: unknown;
}): Record<string, string> | undefined {
  const { path, commit, tool } = input;
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH) return undefined;
  if (commit !== undefined && (typeof commit !== 'string' || !COMMIT.test(commit)))
    return undefined;
  if (
    tool !== undefined &&
    (typeof tool !== 'string' || !(SPEC_SOURCE_TOOLS as readonly string[]).includes(tool))
  ) {
    return undefined;
  }
  return {
    path,
    ...(typeof commit === 'string' ? { commit_sha: commit } : {}),
    ...(typeof tool === 'string' ? { source_tool: tool } : {}),
  };
}

export type LinkedSpec = Awaited<ReturnType<typeof linkSpec>>;

export function linkSpec(client: ApiClient, intentRef: string, body: Record<string, string>) {
  return client.post(`/v1/intents/${segment(intentRef)}/specs`, linkedSpecSchema, body);
}

/** The linked line and, when the spec has no acceptance criteria, the S01 warning. */
export function sayLinked(ctx: CliContext, spec: LinkedSpec): void {
  say(ctx, 'cli.spec.linked', {
    intent: spec.intent,
    version: spec.version,
    path: spec.path,
    commit: spec.commit_sha,
    sha256: spec.content_sha256,
    ...structureParams(spec),
  });
  if (!((spec.acceptance_criteria ?? 0) > 0)) {
    say(ctx, 'cli.spec.no_criteria', { intent: spec.intent });
  }
}

/** S01 (ADR-M61): the tool, the structure rule and the count; `-` when not known. */
export function structureParams(spec: {
  readonly source_tool: string | null;
  readonly structure: string | null;
  readonly acceptance_criteria: number | null;
}): { tool: string; structure: string; criteria: string } {
  return {
    tool: spec.source_tool ?? '-',
    structure: spec.structure ?? '-',
    criteria: spec.acceptance_criteria === null ? '-' : String(spec.acceptance_criteria),
  };
}
