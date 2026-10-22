// D-08 X04 PR 2 (design/ADR-M69 §2.7): the tool events at the end of a run are written once, from
// the gateway's log; a run whose tools never started records `not_started`; a gateway log too large
// to read records its own code; a retried release writes nothing more.
import type { ToolGrant } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { recordToolUse, RunnerError, type DockerClient } from '../../apps/runner/src/index.js';
import { RUN_ID } from './helpers';

type TenantScope = Parameters<typeof recordToolUse>[1];

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
const CALL = JSON.stringify({
  scope: 'request',
  'mcp.method.name': 'tools/call',
  'mcp.target': 'project-docs',
  'http.status': 200,
});

function fakes(options: { started: boolean; logs: string | Error }) {
  const events: { event_type: string; payload: Record<string, unknown> }[] = options.started
    ? [{ event_type: 'tool_started', payload: {} }]
    : [];
  const scope = {
    runContracts: {
      getByRunId: () => Promise.resolve({ contract_json: { tool_grants: [GRANT] } }),
    },
    runEvents: {
      list: () => Promise.resolve([...events]),
      append: (_run: string, event_type: string, payload: Record<string, unknown>) => {
        events.push({ event_type, payload });
        return Promise.resolve();
      },
    },
  } as unknown as TenantScope;
  const docker = {
    containerInspect: () => Promise.resolve({ State: { Running: true } }),
    containerLogs: () =>
      options.logs instanceof Error ? Promise.reject(options.logs) : Promise.resolve(options.logs),
  } as unknown as DockerClient;
  const written = () => events.filter((e) => e.event_type !== 'tool_started');
  return { scope, docker, written };
}

describe('recordToolUse', () => {
  it('writes the counts once; a second release writes nothing', async () => {
    const f = fakes({ started: true, logs: `${CALL}\n${CALL}` });
    await recordToolUse(f.docker, f.scope, RUN_ID);
    await recordToolUse(f.docker, f.scope, RUN_ID);
    expect(f.written()).toEqual([
      {
        event_type: 'tool_used',
        payload: { tool_key: 'project-docs', calls: 2, failed_calls: 0, refused_calls: 0 },
      },
    ]);
  });

  it('records not_started when the tools never started', async () => {
    const f = fakes({ started: false, logs: '' });
    await recordToolUse(f.docker, f.scope, RUN_ID);
    expect(f.written()).toEqual([
      { event_type: 'tool_failed', payload: { tool_key: 'project-docs', reason: 'not_started' } },
    ]);
  });

  it('records counts_too_large when the gateway log cannot be read whole', async () => {
    const f = fakes({ started: true, logs: new RunnerError('runner.docker.response_too_large') });
    await recordToolUse(f.docker, f.scope, RUN_ID);
    expect(f.written()).toEqual([
      {
        event_type: 'tool_failed',
        payload: { tool_key: 'project-docs', reason: 'counts_too_large' },
      },
    ]);
  });
});
