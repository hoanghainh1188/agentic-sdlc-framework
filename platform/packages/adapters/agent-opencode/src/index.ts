// Agent adapter: OpenCode 1.18.35's HTTP server (`opencode serve`). See design/D-08 X03, ADR-M68
// and ADR-M88. The task message, the git commands and the loop key are in `@sdlc/agent-kit`.
export { OpenCodeAdapter, type OpenCodeAdapterOptions } from './adapter.js';
export {
  OpenCodeClient,
  SERVER_USER,
  type OpenCodeClientOptions,
  type OpenCodeMessage,
  type OpenCodePart,
  type SessionState,
} from './client.js';
export {
  AGENT,
  checkStart,
  effectiveConfigProblem,
  EXIT_MARKER,
  exitCodeOf,
  FINISH_RULE,
  globalConfig,
  PROVIDER,
  promptBody,
  TOOL_MAP,
  toolSwitches,
  wrapped,
} from './request.js';
export { ABORTED_ERROR, countsOf, stateOf, type RunCounts, type StateInput } from './status.js';
