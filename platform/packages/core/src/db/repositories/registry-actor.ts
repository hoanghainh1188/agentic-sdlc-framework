import type { ActorType } from '@sdlc/contracts';

/** Who writes a registry record: a person, an agent (plans only) or the platform itself. */
export interface RegistryActor {
  readonly actorType: ActorType;
  /** A UUID for `human` and `agent`; null for `system` (checked by the audit log). */
  readonly actorId: string | null;
}
