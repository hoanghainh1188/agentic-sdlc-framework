// Migration 0025: why an open intent waits (design/D-05 section 6.2, version 1.36; D-08 U02;
// design/ADR-M54 §2.4b; QUESTIONS #265). Rules for every migration: see the header of
// 0001-tenancy.ts and design/ADR-M09.
//
// - The intent workflow's step writes what it decided, under the intent lock, in the step's own
//   transaction: the waiting reason (`IntentWaitReason`), for some reasons a cause (a G4 check
//   code today), when the hold began, and for a HOTL block window when it closes. Every move of
//   the intent (`moveState`) clears them. The API reads them; it never evaluates a gate again.
// - Codes and times only. The cause is open to later gates: only the code format is checked here;
//   a catalog test checks the known causes.
import { defineMigration } from './define.js';

const CODE = `'^[a-z][a-z0-9_]{0,63}$'`;

export const migration0025IntentsWaitingReason = defineMigration({
  up: [
    `ALTER TABLE intents
       ADD COLUMN waiting_reason text,
       ADD COLUMN waiting_cause  text,
       ADD COLUMN waiting_since  timestamptz,
       ADD COLUMN waiting_until  timestamptz,
       ADD CONSTRAINT intents_waiting_reason_code CHECK (waiting_reason ~ ${CODE}),
       ADD CONSTRAINT intents_waiting_cause_code CHECK (waiting_cause ~ ${CODE}),
       ADD CONSTRAINT intents_waiting_set CHECK (
         (waiting_reason IS NULL AND waiting_cause IS NULL AND waiting_since IS NULL
            AND waiting_until IS NULL)
         OR (waiting_reason IS NOT NULL AND waiting_since IS NOT NULL))`,
    `GRANT UPDATE (waiting_reason, waiting_cause, waiting_since, waiting_until) ON intents
       TO platform_app`,
  ],
  // Development only (ADR-M09).
  down: [
    `REVOKE UPDATE (waiting_reason, waiting_cause, waiting_since, waiting_until) ON intents
       FROM platform_app`,
    `ALTER TABLE intents
       DROP CONSTRAINT intents_waiting_set,
       DROP CONSTRAINT intents_waiting_cause_code,
       DROP CONSTRAINT intents_waiting_reason_code,
       DROP COLUMN waiting_until,
       DROP COLUMN waiting_since,
       DROP COLUMN waiting_cause,
       DROP COLUMN waiting_reason`,
  ],
});
