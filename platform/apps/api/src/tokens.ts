// Dependency injection tokens. The app injects with `@Inject(TOKEN)` everywhere, so it needs no
// decorator metadata and no SWC transform in tests (ADR-M26 section 2.1).
export const DATABASE = Symbol('PlatformDatabase');
export const REGISTRY = Symbol('Registry');
export const SETTINGS = Symbol('ApiSettings');
export const CLOCK = Symbol('Clock');
export const INTENTS = Symbol('IntentsService');
