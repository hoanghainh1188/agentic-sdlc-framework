// `sdlc ops agent show|list|suspend|quarantine`: the agent register on the server (task C10,
// ADR-M31 §2.2; task B13, QUESTIONS #153, ADR-M37 §2.8). Operator commands with SDLC_DB_URL
// (`platform_app`), audited as actor `system`. Registering, changing, approving, activating and
// retiring an agent go through the API (`sdlc admin agent …`), where handbook Ch.20's approval
// rules are enforced. Only the two safety moves stay here, for when the API is down; an agent is
// never activated through ops.
import { parseArgs } from 'node:util';

import {
  AgentRegisterError,
  agentRegisterErrorMessage,
  changeAgentStatus,
  recertificationMonths,
  recertificationStatus,
  type Agent,
  type TenantScope,
} from '@sdlc/core';
import { t, type MessageKey } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';

type Values = Record<string, string | boolean | undefined>;
type Scoped = (scope: TenantScope, values: Values, ctx: CliContext) => Promise<number>;

const BASE = {
  tenant: { type: 'string' },
  key: { type: 'string' },
  json: { type: 'boolean', default: false },
} as const;

const SPECS = {
  suspend: { ...BASE, reason: { type: 'string' } },
  quarantine: { ...BASE, reason: { type: 'string' } },
  show: { ...BASE, project: { type: 'string' } },
  list: {
    tenant: { type: 'string' },
    project: { type: 'string' },
    overdue: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
} as const;
type Command = keyof typeof SPECS;

/** The `sdlc ops agent` commands; `cli.ops.usage` lists them (test `cli/usage-texts.test.ts`). */
export const OPS_AGENT_COMMANDS: readonly string[] = Object.keys(SPECS);
type AgentStatus = Agent['status'];

const REQUIRED: Readonly<Record<Command, readonly string[]>> = {
  suspend: ['tenant', 'key', 'reason'],
  quarantine: ['tenant', 'key', 'reason'],
  show: ['tenant', 'key'],
  list: ['tenant'],
};

/** Parses `args` (after `ops agent`). Undefined: print the usage. */
export function parseAgentCommand(
  args: readonly string[],
): { command: Command; values: Values } | undefined {
  const [first, ...rest] = args;
  if (first === undefined || !Object.hasOwn(SPECS, first)) return undefined;
  const command = first as Command;
  try {
    const { values } = parseArgs({
      args: [...rest],
      options: SPECS[command],
      strict: true,
      allowPositionals: false,
    });
    const found = values as Values;
    if (!REQUIRED[command].every((key) => typeof found[key] === 'string')) return undefined;
    return { command, values: found };
  } catch {
    return undefined;
  }
}

/** Runs an agent command against the tenant scope. Returns the exit code. */
export async function runAgentCommand(
  scope: TenantScope,
  command: Command,
  values: Values,
  ctx: CliContext,
): Promise<number> {
  try {
    return await HANDLERS[command](scope, values, ctx);
  } catch (error) {
    if (error instanceof AgentRegisterError) {
      ctx.stderr(agentRegisterErrorMessage(error, opt(values, 'key')));
      return error.code === 'invalid_input' ? EXIT.usage : EXIT.failed;
    }
    throw error;
  }
}

const str = (values: Values, key: string): string => String(values[key]);
const opt = (values: Values, key: string): string | undefined =>
  typeof values[key] === 'string' ? values[key] : undefined;

function statusHandler(to: 'suspended' | 'quarantined'): Scoped {
  return async (scope, values, ctx) => {
    const agent = await changeAgentStatus(scope, str(values, 'key'), {
      to,
      reason: str(values, 'reason'),
    });
    return print(scope, agent, values, ctx, 'cli.admin.agent.status_changed');
  };
}

const show: Scoped = async (scope, values, ctx) => {
  const agent = await scope.agents.getByKey(str(values, 'key'));
  if (!agent) {
    ctx.stderr(t('agent_register.error.agent_not_found', { key: str(values, 'key') }));
    return EXIT.failed;
  }
  const months = await monthsFor(scope, values, ctx);
  if (months === undefined) return EXIT.usage;
  const described = describe(agent, months);
  if (values.json === true) ctx.stdout(JSON.stringify(described, null, 2));
  else ctx.stdout(t('cli.admin.agent.detail', text(described)));
  return EXIT.ok;
};

const listAgents: Scoped = async (scope, values, ctx) => {
  const months = await monthsFor(scope, values, ctx);
  if (months === undefined) return EXIT.usage;
  const agents = (await scope.agents.list())
    .map((agent) => describe(agent, months))
    .filter((agent) => values.overdue !== true || (agent.status === 'active' && agent.overdue));
  if (values.json === true) {
    ctx.stdout(JSON.stringify(agents, null, 2));
    return EXIT.ok;
  }
  if (agents.length === 0) ctx.stdout(t('cli.admin.agent.none'));
  for (const agent of agents) ctx.stdout(t('cli.admin.agent.line', text(agent)));
  return EXIT.ok;
};

const HANDLERS: Readonly<Record<Command, Scoped>> = {
  suspend: statusHandler('suspended'),
  quarantine: statusHandler('quarantined'),
  show,
  list: listAgents,
};

/** The recertification age: from `--project`'s configuration, else the configuration default. */
async function monthsFor(
  scope: TenantScope,
  values: Values,
  ctx: CliContext,
): Promise<number | undefined> {
  const slug = opt(values, 'project');
  if (slug === undefined) return recertificationMonths(scope, null);
  const project = await scope.projects.getBySlug(slug);
  if (!project) {
    ctx.stderr(t('cli.admin.agent.project_not_found', { slug }));
    return undefined;
  }
  return recertificationMonths(scope, project.id);
}

interface DescribedAgent {
  readonly key: string;
  readonly id: string;
  readonly version: string;
  readonly status: AgentStatus;
  readonly owner_id: string;
  readonly model_ref: string | null;
  readonly instructions_ref: string;
  readonly instructions_sha256: string;
  readonly allowed_tools: readonly string[];
  readonly max_autonomy: string;
  readonly approved_environments: readonly string[];
  readonly last_recertified_at: string | null;
  readonly recertification_due_on: string | null;
  readonly overdue: boolean;
}

function describe(agent: Agent, months: number, now: Date = new Date()): DescribedAgent {
  const recert = recertificationStatus(agent.last_recertified_at, months, now);
  return {
    key: agent.agent_key,
    id: agent.id,
    version: agent.version,
    status: agent.status,
    owner_id: agent.owner_id,
    model_ref: agent.model_ref,
    instructions_ref: agent.instructions_ref,
    instructions_sha256: agent.instructions_sha256,
    allowed_tools: agent.allowed_tools,
    max_autonomy: agent.max_autonomy,
    approved_environments: agent.approved_environments,
    last_recertified_at: agent.last_recertified_at,
    recertification_due_on: recert.dueOn,
    // Only an agent that may run needs a current certification.
    overdue: agent.status === 'active' && recert.overdue,
  };
}

/** Message parameters: lists joined, missing values as `-`, the overdue flag as catalog text. */
function text(agent: DescribedAgent): Record<string, string> {
  return {
    key: agent.key,
    id: agent.id,
    version: agent.version,
    status: agent.status,
    owner_id: agent.owner_id,
    model: agent.model_ref ?? '-',
    instructions: agent.instructions_ref,
    instructions_sha256: agent.instructions_sha256,
    tools: agent.allowed_tools.join(',') || '-',
    max_autonomy: agent.max_autonomy,
    environments: agent.approved_environments.join(',') || '-',
    recertified: agent.last_recertified_at ?? '-',
    due: agent.recertification_due_on ?? '-',
    overdue: agent.overdue ? t('cli.admin.agent.overdue_flag') : '',
  };
}

async function print(
  scope: TenantScope,
  agent: Agent,
  values: Values,
  ctx: CliContext,
  message: MessageKey,
): Promise<number> {
  const described = describe(agent, await recertificationMonths(scope, null));
  ctx.stdout(
    values.json === true
      ? JSON.stringify(described, null, 2)
      : t(message, { key: agent.agent_key, version: agent.version, status: agent.status }),
  );
  return EXIT.ok;
}
