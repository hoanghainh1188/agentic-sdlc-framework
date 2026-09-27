// Request validation with zod (ADR-M26 section 2.1). zod's English text never reaches the client:
// a failure becomes `invalid_request` with the paths and issue codes only.
import type { z } from 'zod';

import { ApiError } from './errors/api-error.js';

export function parseRequest<T extends z.ZodType>(
  schema: T,
  value: unknown,
  where: 'body' | 'query' | 'path',
): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(
    400,
    'invalid_request',
    undefined,
    result.error.issues.slice(0, 20).map((issue) => ({
      path: [where, ...issue.path.map(String)].join('.'),
      issue: issue.code,
    })),
  );
}
