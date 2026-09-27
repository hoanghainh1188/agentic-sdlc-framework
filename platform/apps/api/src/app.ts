// Builds the Nest application (task B03, ADR-M26). `main.ts` runs it; tests build it with their
// own database and clock and call it through Fastify `inject()`, without opening a port.
import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { IntentWorkflowSignals } from '@sdlc/contracts';
import { Registry, type PlatformDatabase } from '@sdlc/core';
import { NO_INTENT_SIGNALS } from '@sdlc/workflow-client';

import { AiRecordsController } from './ai-records/ai-records.controller.js';
import { AiRecordsService } from './ai-records/ai-records.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { RateLimiter } from './auth/rate-limiter.js';
import { ErrorFilter } from './errors/error.filter.js';
import { EscalationsController } from './escalations/escalations.controller.js';
import { EscalationsService } from './escalations/escalations.service.js';
import { HealthController } from './health/health.controller.js';
import { IntentsController } from './intents/intents.controller.js';
import { IntentsService } from './intents/intents.service.js';
import { MeController } from './me/me.controller.js';
import type { ApiSettings } from './settings.js';
import { AI_RECORDS, CLOCK, DATABASE, ESCALATIONS, INTENTS, REGISTRY, SETTINGS } from './tokens.js';

/** Largest accepted request body. Intents carry at most ~10 kB of text. */
const BODY_LIMIT_BYTES = 64 * 1024;

export interface ApiDeps {
  readonly db: PlatformDatabase;
  readonly settings: Pick<ApiSettings, 'rateLimitPerMinute' | 'authFailuresPerMinute'>;
  /** Default: the system clock. */
  readonly now?: () => Date;
  /** Default: Nest's logger. Tests pass their own to check that no token is logged. */
  readonly logger?: Pick<Logger, 'error'>;
  /**
   * Wakes the intent workflow after a change (B07, ADR-M30). Default: no signals; the worker's
   * reconcile loop then catches up.
   */
  readonly intentSignals?: IntentWorkflowSignals;
}

@Module({})
class ApiModule {
  static create(deps: ApiDeps): DynamicModule {
    const now = deps.now ?? (() => new Date());
    const signals = deps.intentSignals ?? NO_INTENT_SIGNALS;
    const wakeLogger = new Logger('sdlc-api');
    return {
      module: ApiModule,
      controllers: [
        HealthController,
        MeController,
        IntentsController,
        EscalationsController,
        AiRecordsController,
      ],
      providers: [
        { provide: DATABASE, useValue: deps.db },
        { provide: SETTINGS, useValue: deps.settings },
        { provide: CLOCK, useValue: now },
        {
          provide: REGISTRY,
          useValue: new Registry({
            policyFactory: (config) => createSimplePolicyEngine({ config }),
            now,
          }),
        },
        {
          provide: INTENTS,
          useFactory: (registry: Registry) => new IntentsService(registry, signals, wakeLogger),
          inject: [REGISTRY],
        },
        { provide: ESCALATIONS, useValue: new EscalationsService(now, signals, wakeLogger) },
        { provide: AI_RECORDS, useValue: new AiRecordsService(signals, wakeLogger, now) },
        {
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) =>
            new AuthGuard({
              reflector,
              db: deps.db,
              requests: new RateLimiter(deps.settings.rateLimitPerMinute),
              failures: new RateLimiter(deps.settings.authFailuresPerMinute),
              now,
            }),
          inject: [Reflector],
        },
        {
          provide: APP_FILTER,
          useValue: new ErrorFilter(deps.logger ?? new Logger('sdlc-api')),
        },
      ],
    };
  }
}

export async function createApp(deps: ApiDeps): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.create(deps),
    new FastifyAdapter({ bodyLimit: BODY_LIMIT_BYTES, trustProxy: false }),
    { logger: ['error', 'warn'] },
  );
  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
