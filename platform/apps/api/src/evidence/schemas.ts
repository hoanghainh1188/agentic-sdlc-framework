// Request schemas of the Evidence Pack endpoints (task E02, ADR-M48 §2.6). The intent is a code
// or an ID; the version a positive integer; the file `manifest` or `markdown`.
import { z } from 'zod';

export const packVersionSchema = z.coerce.number().int().min(1).max(1_000_000);
export const packFileSchema = z.enum(['manifest', 'markdown']);
export type PackFile = z.infer<typeof packFileSchema>;
