// The first register tool, `read_documents` (task X04 PR 3b, design/ADR-M89): its MCP handling and
// the checks of its runtime files, for the tests. The process itself is `main.ts`.
export {
  answerText,
  callArguments,
  DEFAULT_LIMIT,
  handleMessage,
  logLineOf,
  TOOL_NAME,
  type JsonRpcAnswer,
  type McpDeps,
  type SearchHit,
} from './mcp.js';
export { readRuntime, RuntimeError } from './runtime.js';
