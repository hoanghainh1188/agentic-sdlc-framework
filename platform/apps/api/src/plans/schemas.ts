// Request schema of the plan endpoint (task B09, ADR-M40 §2.3). The plan file's path comes from
// the intent code; the text is never sent: the platform reads it from the Git host.
import { z } from 'zod';

export const submitPlanSchema = z.strictObject({
  commit_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});
