// Evidence Pack endpoints of an intent (task E02, D-08 E02 AC1–AC4, ADR-M48 §2.6). Every handler
// works on the caller's tenant scope.
import { Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { intentRefSchema } from '../intents/schemas.js';
import { EVIDENCE } from '../tokens.js';
import { parseRequest } from '../validation.js';
import type { EvidenceService } from './evidence.service.js';
import { packFileSchema, packVersionSchema } from './schemas.js';

@Controller('v1/intents/:intent/evidence-packs')
export class EvidenceController {
  constructor(@Inject(EVIDENCE) private readonly evidence: EvidenceService) {}

  /** Builds a new version (201), or returns the latest when nothing changed (200). */
  @Post()
  async build(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Res({ passthrough: true }) reply: { status(code: number): unknown },
  ): Promise<Record<string, unknown>> {
    const result = await this.evidence.build(p, parseRequest(intentRefSchema, ref, 'path'));
    reply.status(result.created ? 201 : 200);
    return result.body;
  }

  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
  ): Promise<Record<string, unknown>> {
    return this.evidence.list(p, parseRequest(intentRefSchema, ref, 'path'));
  }

  @Get(':version')
  show(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Param('version') version: string,
  ): Promise<Record<string, unknown>> {
    return this.evidence.show(
      p,
      parseRequest(intentRefSchema, ref, 'path'),
      parseRequest(packVersionSchema, version, 'path'),
    );
  }

  @Get(':version/:file')
  file(
    @CurrentPrincipal() p: Principal,
    @Param('intent') ref: string,
    @Param('version') version: string,
    @Param('file') file: string,
  ): Promise<Record<string, unknown>> {
    return this.evidence.file(
      p,
      parseRequest(intentRefSchema, ref, 'path'),
      parseRequest(packVersionSchema, version, 'path'),
      parseRequest(packFileSchema, file, 'path'),
    );
  }
}
