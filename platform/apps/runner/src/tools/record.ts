// The run events of a run's register tools at its end (task X04, design/ADR-M69 §2.7): called
// before the gateway is removed, at the end of a run, after a kill or a failure, and by the
// clean-up after a restart. One `tool_used` per granted tool, one `tool_refused` per refusal
// reason, a `tool_failed` for a tool that stopped. Codes and counts only.
import type { ToolGrant } from '@sdlc/contracts';
import type { TenantScope } from '@sdlc/core';

import type { DockerClient } from '../docker/client.js';
import { RunnerError } from '../errors.js';
import { toolObjectNames } from '../names.js';
import { toolUsage } from './usage.js';

/** The grants of a run's stored contract (none before schema 3). */
async function grantsOf(scope: TenantScope, runId: string): Promise<readonly ToolGrant[]> {
  const stored = await scope.runContracts.getByRunId(runId);
  const contract = stored?.contract_json as { tool_grants?: readonly ToolGrant[] } | undefined;
  return contract?.tool_grants ?? [];
}

/** Event types this module writes: at most once per run (a retried release writes nothing). */
const TOOL_END_EVENTS = new Set(['tool_used', 'tool_refused', 'tool_failed']);

export async function recordToolUse(
  docker: DockerClient,
  scope: TenantScope,
  runId: string,
): Promise<void> {
  const grants = await grantsOf(scope, runId);
  if (grants.length === 0) return;
  const events = await scope.runEvents.list(runId);
  if (events.some((event) => TOOL_END_EVENTS.has(event.event_type))) return;
  const names = toolObjectNames(runId);
  // The tools never started (provisioning failed before them): nothing to count.
  if (!events.some((event) => event.event_type === 'tool_started')) {
    for (const grant of grants) {
      await scope.runEvents.append(runId, 'tool_failed', {
        tool_key: grant.tool_key,
        reason: 'not_started',
      });
    }
    return;
  }
  for (const grant of grants) {
    const info = await docker.containerInspect(names.tool(grant.tool_key)).catch(() => undefined);
    if (info !== undefined && !info.State.Running) {
      await scope.runEvents.append(runId, 'tool_failed', {
        tool_key: grant.tool_key,
        reason: 'stopped',
      });
    }
  }
  let logs: string | undefined;
  let reason = 'counts_unavailable';
  try {
    if (await docker.containerInspect(names.gateway)) {
      logs = await docker.containerLogs(names.gateway, { stderr: true });
    }
  } catch (error) {
    // The log is bounded (`TOOL_LOG_CONFIG`); a log the runner cannot read whole is its own code.
    if (error instanceof RunnerError && error.key === 'runner.docker.response_too_large') {
      reason = 'counts_too_large';
    }
    logs = undefined;
  }
  if (logs === undefined) {
    // No gateway to read (it is gone, or its log is too large): the counts are not known.
    for (const grant of grants) {
      await scope.runEvents.append(runId, 'tool_failed', { tool_key: grant.tool_key, reason });
    }
    return;
  }
  const usage = toolUsage(logs, grants);
  for (const { toolKey, counts } of usage.tools) {
    await scope.runEvents.append(runId, 'tool_used', {
      tool_key: toolKey,
      calls: counts.calls,
      failed_calls: counts.failedCalls,
      refused_calls: counts.refusedCalls,
    });
  }
  for (const refusal of usage.refusals) {
    await scope.runEvents.append(runId, 'tool_refused', {
      reason: refusal.reason,
      ...(refusal.toolKey === undefined ? {} : { tool_key: refusal.toolKey }),
    });
  }
}
