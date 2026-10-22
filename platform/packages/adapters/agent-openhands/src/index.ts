// Agent adapter: OpenHands Agent Server 1.48.0 over REST. See design/D-03 section 7.2, D-08 C05,
// ADR-M10 and ADR-M29. The task message, the git commands and the loop key are in
// `@sdlc/agent-kit` (ADR-M88 §2.3).
export {
  MAX_ITERATIONS_CODE,
  OpenHandsAdapter,
  toAgentState,
  type OpenHandsAdapterOptions,
} from './adapter.js';
export {
  AgentServerClient,
  EXECUTION_STATUSES,
  SESSION_HEADER,
  type AgentEventRecord,
  type BashResult,
  type ClientOptions,
  type ExecutionStatus,
} from './client.js';
export { toolCallKey, trailingIdenticalCalls } from './loop.js';
export {
  buildConversationRequest,
  FINISH_RULE,
  taskMessage,
  type ConversationRequestInput,
} from './request.js';
