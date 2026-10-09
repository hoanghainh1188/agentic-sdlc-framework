// The stored proposal of an L1 run (task C13, design/ADR-M64 §2.1): the patch, checked against its
// row before it is served, every read audited. The roles in `access.evidence_read_roles` and
// tenant admins. Client code: the api never logs or keeps the bytes.
import { Controller, Get, Header, Inject, Param } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { intentRefSchema } from '../intents/schemas.js';
import { runRefSchema } from '../runs/schemas.js';
import { EVIDENCE } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { EvidenceService } from './evidence.service.js';

@Controller('v1/intents/:intent/runs/:run/proposal')
export class ProposalController {
  constructor(@Inject(EVIDENCE) private readonly evidence: EvidenceService) {}

  @Get()
  // Client code: never kept by a browser or a proxy.
  @Header('Cache-Control', 'no-store')
  read(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Param('run') run: string,
  ): Promise<Record<string, unknown>> {
    return this.evidence.proposal(
      p,
      parseRequest(intentRefSchema, ref, 'path'),
      parseRequest(runRefSchema, run, 'path'),
    );
  }
}
