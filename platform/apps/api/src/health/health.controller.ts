// Health checks for Compose and operators. No token, no data: `ready` only says whether the
// database answers.
import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import type { PlatformDatabase } from '@sdlc/core';

import { Public } from '../auth/auth.guard.js';
import { ApiError } from '../errors/api-error.js';
import { DATABASE } from '../tokens.js';

@Controller('health')
@Public()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: PlatformDatabase) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await this.db.system.ping();
    } catch {
      throw new ApiError(503, 'internal');
    }
    return { status: 'ok' };
  }
}
