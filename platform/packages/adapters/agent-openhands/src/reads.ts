// The files the agent opened, from its log (D-08 X07 AC1, ADR-M90 §2.1). On the Agent Server
// 1.48.0 the agent reads a file with `file_editor` and the command `view`; a `terminal` command can
// read files without naming them, so it is only counted. The paths go back to the runner, which
// hashes them; they never leave the adapter in a status.
import { fileReadsOf } from '@sdlc/agent-kit';
import type { AgentFileReads, AgentLogEvent } from '@sdlc/contracts';

const ACTION_EVENT = 'ActionEvent';
const FILE_TOOL = 'file_editor';
const SHELL_TOOL = 'terminal';

function argumentsOf(event: AgentLogEvent): Record<string, unknown> {
  const toolCall = event.tool_call as { arguments?: unknown } | undefined;
  const raw = toolCall?.arguments ?? event.action;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The files `file_editor view` opened and the number of `terminal` calls, in `workingDir`. */
export function fileReads(events: readonly AgentLogEvent[], workingDir: string): AgentFileReads {
  const paths: string[] = [];
  let unattributed = 0;
  for (const event of events) {
    if (event.kind !== ACTION_EVENT) continue;
    if (event.tool_name === SHELL_TOOL) {
      unattributed += 1;
      continue;
    }
    if (event.tool_name !== FILE_TOOL) continue;
    const args = argumentsOf(event);
    if (args.command === 'view' && typeof args.path === 'string') paths.push(args.path);
  }
  return fileReadsOf(paths, workingDir, unattributed);
}
