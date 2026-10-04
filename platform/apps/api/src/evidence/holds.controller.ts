// Evidence holds of an intent (task E05, design/ADR-M51, QUESTIONS #235; handbook Ch.15). A hold
// keeps the intent's evidence files from the purge until it is released. Who: tenant admins, or a
// role in config `access.evidence_hold_roles` (never `viewer`, rule M32). Every handler works on
// the caller's tenant scope.
import { Body, Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import {
  holdEvidence,
  releaseEvidenceHold,
  showEvidenceHolds,
  type EvidenceHold,
} from '@sdlc/core';
import { z } from 'zod';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { intentRefSchema } from '../intents/schemas.js';
import { parseRequest } from '../validation.js';

export const holdBodySchema = z.strictObject({
  reason_ref: z
    .string()
    .max(512)
    .regex(/^https:\/\/\S+$/)
    .optional(),
});

/** A hold as the API shows it: IDs, times and the optional link; never text. */
export function presentHold(hold: EvidenceHold): Record<string, unknown> {
  return {
    id: hold.id,
    held_by: hold.held_by,
    reason_ref: hold.reason_ref,
    created_at: hold.created_at.toISOString(),
    released_at: hold.released_at?.toISOString() ?? null,
    released_by: hold.released_by,
  };
}

@Controller('v1/intents/:intent/evidence-hold')
export class EvidenceHoldsController {
  @Get()
  async show(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
  ): Promise<Record<string, unknown>> {
    const view = await showEvidenceHolds(
      p.scope,
      { userId: p.userId },
      parseRequest(intentRefSchema, ref, 'path'),
    );
    return {
      intent: view.intent.code,
      active: view.active ? presentHold(view.active) : null,
      history: view.history.map(presentHold),
    };
  }

  @Put()
  @HttpCode(201)
  async hold(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = parseRequest(holdBodySchema, body ?? {}, 'body');
    const hold = await holdEvidence(
      p.scope,
      { userId: p.userId },
      parseRequest(intentRefSchema, ref, 'path'),
      input.reason_ref ?? null,
    );
    return { hold: presentHold(hold) };
  }

  @Delete()
  async release(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
  ): Promise<Record<string, unknown>> {
    const hold = await releaseEvidenceHold(
      p.scope,
      { userId: p.userId },
      parseRequest(intentRefSchema, ref, 'path'),
    );
    return { hold: presentHold(hold) };
  }
}
