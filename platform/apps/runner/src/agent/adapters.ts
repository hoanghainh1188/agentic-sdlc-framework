// The agent adapters of a runner process (X03, ADR-M68 §7, ADR-M88; QUESTIONS #526). The Run
// Contract names the adapter of its agent (`agent_adapter`); the runner drives the run with that
// adapter only, and refuses a contract whose adapter it does not have (`adapter_unavailable`)
// before it clones anything.
import type { AgentAdapter, AgentAdapterCode } from '@sdlc/contracts';

/** The adapters this runner has, by code. */
export type AgentAdapters = Readonly<Partial<Record<AgentAdapterCode, AgentAdapter>>>;

/** The adapter of `code`, or undefined when this runner has none. */
export function adapterFor(
  adapters: AgentAdapters | undefined,
  code: AgentAdapterCode,
): AgentAdapter | undefined {
  return adapters && Object.hasOwn(adapters, code) ? adapters[code] : undefined;
}

/** The codes of the adapters this runner has. */
export function adapterCodes(adapters: AgentAdapters): AgentAdapterCode[] {
  return (Object.keys(adapters) as AgentAdapterCode[]).filter((code) => adapters[code]);
}
