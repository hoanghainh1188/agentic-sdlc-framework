// Request schema of the run endpoints (task C11, ADR-M42 §2.6): a run is addressed by its ID.
import { z } from 'zod';

export const runRefSchema = z.uuid();
