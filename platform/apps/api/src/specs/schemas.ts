// Request schemas of the spec endpoints (task B08, ADR-M39 §2.2). The path is checked again in
// core (`isSpecPath`); the content is never sent: the platform reads it from the Git host.
import { SPEC_SOURCE_TOOLS } from '@sdlc/core';
import { z } from 'zod';

export const linkSpecSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  commit_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  source_tool: z.enum(SPEC_SOURCE_TOOLS).optional(),
});
