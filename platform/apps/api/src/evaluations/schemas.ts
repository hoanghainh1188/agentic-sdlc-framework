// Request schemas of evaluation plans and evaluations (task L05, ADR-M82 §2.1, §2.7). Codes,
// numbers, decimal amounts and one repository path per prompt variant: never a prompt text.
import { EVALUATION_TASK_REJECT_REASONS } from '@sdlc/core';
import { DATA_CLASSES, PROVIDER_TYPES } from '@sdlc/contracts';

import { stepUpAnswerSchema } from '../passkeys/schemas.js';
import { z } from 'zod';

export const projectSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const planIdSchema = z.uuid();
export const evaluationCodeSchema = z.string().regex(/^EVAL-[0-9]{4}-[0-9]{4,9}$/);

const usd = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/);
const promptPath = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){0,15}$/);

const configuration = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
    agent_key: z.string().max(64).nullable().default(null),
    model: z.string().max(128).nullable().default(null),
    provider_type: z.enum(PROVIDER_TYPES).nullable().default(null),
    max_iterations: z.number().int().min(1).max(200),
    max_duration_min: z.number().int().min(1).max(120),
    prompt_path: promptPath.nullable().default(null),
  })
  .refine((c) => (c.agent_key === null) !== (c.model === null), {
    message: 'agent_key or model',
    path: ['agent_key'],
  });

const content = {
  data_class: z.enum(DATA_CLASSES),
  // L07 (ADR-M85 §2.10): a `project` plan runs the project's approved tasks and has no version.
  task_set_kind: z.enum(['folder', 'project']).default('folder'),
  task_set_version: z.number().int().min(1).max(1000).nullable().default(null),
  task_ids: z.array(z.string().max(64)).max(64).nullable().default(null),
  runs_per_task: z.number().int().min(1).max(20),
  budget_per_run_usd: usd,
  monthly_cap_usd: usd,
  trigger: z.enum(['once', 'schedule', 'on_change']),
  schedule: z
    .strictObject({
      every: z.enum(['daily', 'weekly']),
      hour: z.number().int().min(0).max(23),
      weekday: z.number().int().min(1).max(7).nullable().default(null),
    })
    .nullable()
    .default(null),
  configurations: z.array(configuration).min(1).max(16),
};

/**
 * The passkey answer of a dashboard session (ADR-M82 §2.7): needed for Run now, and for a create
 * or change that turns a schedule or `on_change` on or raises a budget. A token never needs it.
 */
const stepUp = { step_up: stepUpAnswerSchema.optional() };

export const createPlanSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  ...content,
  ...stepUp,
});

export const changePlanSchema = z.strictObject({
  /** The version the caller read: a plan changed since then is refused (`plan_changed`). */
  expected_version: z.number().int().min(1),
  ...content,
  ...stepUp,
});

/** The body of Run now: empty, or the passkey answer of a dashboard session. */
export const runPlanSchema = z.strictObject(stepUp);

export const listEvaluationsSchema = z.strictObject({
  project: projectSlugSchema.optional(),
  plan: planIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type PlanBody = z.infer<typeof createPlanSchema> | z.infer<typeof changePlanSchema>;

// L07 (ADR-M85): a project's own evaluation tasks. Codes, IDs and hashes only.
const taskIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
export const evalTaskIdSchema = z.uuid();
export const draftTaskSchema = z.strictObject({
  intent: z.string().regex(/^INT-[0-9]{4}-[0-9]{4,9}$/),
  task: taskIdSchema,
});
export const registerTaskSchema = z.strictObject({ task: taskIdSchema });
export const approveTaskSchema = z.strictObject({
  card_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const rejectTaskSchema = z.strictObject({
  card_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.enum(EVALUATION_TASK_REJECT_REASONS),
});
