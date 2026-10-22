// D-08 X04 PR 2 (design/ADR-M69 §2.4, QUESTIONS #519): the OpenHands Agent Server gets the run's
// MCP gateway as one `mcp_config` entry, with the per-run key in a header, only when the contract
// grants register tools. Confirmed on Agent Server 1.48.0 (`StartConversationRequest.agent`).
import { buildConversationRequest, MCP_SERVER_NAME } from '@sdlc/adapter-agent-openhands';
import { toolsOf } from '@sdlc/agent-kit';
import { AgentError, TOOL_GATEWAY_URL, type RunContract, type ToolGrant } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { CONTRACT, TASK, VIRTUAL_KEY } from './helpers';

const GRANT: ToolGrant = {
  tool_key: 'project-docs',
  tool_version: '1.0.0',
  transport: 'http',
  image_digest: `sha256:${'d'.repeat(64)}`,
  permissions: ['read_documents'],
  call_rules_sha256: 'a'.repeat(64),
  backing_services: [],
  max_calls: 100,
};
const WITH_TOOLS: RunContract = {
  ...CONTRACT,
  schema_version: 3,
  allowed_tools: [...CONTRACT.allowed_tools, 'tool:project-docs'].sort(),
  tool_grants: [GRANT],
};
const TOOL_KEY = 'per-run-tool-key';

const input = (contract: RunContract, tools?: { url: string; key: string }) => ({
  contract,
  model: 'gpt-oss-20b',
  llmBaseUrl: 'http://litellm:4000',
  virtualKey: VIRTUAL_KEY,
  workingDir: '/workspace',
  task: TASK,
  ...(tools === undefined ? {} : { tools }),
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof AgentError ? error.code : 'other';
  }
  return undefined;
}

describe('the run MCP gateway in the OpenHands request (X04)', () => {
  it('adds one MCP server, the gateway with the key header, and keeps the built-in tools', () => {
    const body = buildConversationRequest(
      input(WITH_TOOLS, { url: TOOL_GATEWAY_URL, key: TOOL_KEY }),
    ) as { agent: { mcp_config: unknown; tools: unknown } };
    expect(body.agent.mcp_config).toEqual({
      [MCP_SERVER_NAME]: {
        url: 'http://tools:3000/mcp',
        transport: 'http',
        headers: { Authorization: `Bearer ${TOOL_KEY}` },
      },
    });
    expect(body.agent.tools).toEqual([
      { name: 'file_editor', params: {} },
      { name: 'terminal', params: {} },
    ]);
  });

  it('adds no MCP server without grants', () => {
    const body = buildConversationRequest(input(CONTRACT)) as { agent: Record<string, unknown> };
    expect(body.agent).not.toHaveProperty('mcp_config');
  });

  it.each([
    ['grants without the gateway', WITH_TOOLS, undefined],
    ['the gateway without grants', CONTRACT, { url: TOOL_GATEWAY_URL, key: TOOL_KEY }],
    ['another URL', WITH_TOOLS, { url: 'http://evil:3000/mcp', key: TOOL_KEY }],
    ['an empty key', WITH_TOOLS, { url: TOOL_GATEWAY_URL, key: '' }],
  ])('refuses %s', (_name, contract, tools) => {
    expect(code(() => buildConversationRequest(input(contract, tools)))).toBe('tool_not_allowed');
  });
});

describe('toolsOf (X04)', () => {
  it('refuses register tools unless the adapter wires the gateway', () => {
    expect(code(() => toolsOf(WITH_TOOLS))).toBe('tool_not_allowed');
    expect(toolsOf(WITH_TOOLS, { registerTools: true })).toEqual(['file_editor', 'terminal']);
  });
});
