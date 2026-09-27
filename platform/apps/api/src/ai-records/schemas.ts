// Request schemas of the project AI record (task B12, ADR-M32 §2.4). Codes from @sdlc/contracts
// and one https link: the record holds no free text (QUESTIONS.md #104).
import {
  AI_ALLOWED_VALUES,
  DATA_CLASSES,
  DISCLOSURE_FORMATS,
  PROD_LOGS_ALLOWED_VALUES,
} from '@sdlc/contracts';
import { z } from 'zod';

export const projectSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const saveAiRecordSchema = z.strictObject({
  /** The version read; 0 creates the record. */
  expected_version: z.number().int().min(0),
  ai_allowed: z.enum(AI_ALLOWED_VALUES),
  allowed_data_classes: z.array(z.enum(DATA_CLASSES)).max(DATA_CLASSES.length),
  prod_logs_allowed: z.enum(PROD_LOGS_ALLOWED_VALUES),
  disclosure_format: z.enum(DISCLOSURE_FORMATS),
  confirmed_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  record_ref: z
    .string()
    .max(512)
    .regex(/^https:\/\/\S+$/)
    .nullable()
    .default(null),
});
