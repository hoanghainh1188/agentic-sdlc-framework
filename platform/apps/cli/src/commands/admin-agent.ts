// `sdlc admin agent …`: the agent register (task C10, handbook Ch.20, design/ADR-M31 §2.2).
// Operator commands, run on the server with SDLC_DB_URL (`platform_app`), like `sdlc admin token`.
// There is no user login, so the audit events use actor `system`. Task B13 moves this behind the API
// once a tenant admin exists (QUESTIONS.md #65).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import {
  AgentRegisterError,
  agentRegisterErrorMessage,
  changeAgentOwner,
  changeAgentStatus,
  recertificationMonths,
  recertificationStatus,
  recertifyAgent,
  registerAgent,
  updateAgent,
  type Agent,
  type TenantScope,
  type UpdateAgent,
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
const CONFIG = {
  model: { type: 'string' },
  instructions: { type: 'string' },
  'instructions-sha256': { type: 'string' },
  'instructions-file': { type: 'string' },
  tools: { type: 'string' },
  'max-autonomy': { type: 'string' },
  environments: { type: 'string' },
} as const;

const SPECS = {
  register: { ...BASE, ...CONFIG, version: { type: 'string' }, owner: { type: 'string' } },
  update: { ...BASE, ...CONFIG, version: { type: 'string' } },
  activate: BASE,
  suspend: { ...BASE, reason: { type: 'string' } },
  quarantine: { ...BASE, reason: { type: 'string' } },
  retire: { ...BASE, reason: { type: 'string' } },
  owner: { ...BASE, owner: { type: 'string' } },
  recertify: { ...BASE, date: { type: 'string' } },
  show: { ...BASE, project: { type: 'string' } },
  list: {
    tenant: { type: 'string' },
    project: { type: 'string' },
    overdue: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
} as const;
type Command = keyof typeof SPECS;
type AgentStatus = Agent['status'];

const REQUIRED: Readonly<Record<Command, readonly string[]>> = {
  register: ['tenant', 'key', 'version', 'owner', 'instructions', 'max-autonomy'],
  update: ['tenant', 'key', 'version'],
  activate: ['tenant', 'key'],
  suspend: ['tenant', 'key', 'reason'],
  quarantine: ['tenant', 'key', 'reason'],
  retire: ['tenant', 'key', 'reason'],
  owner: ['tenant', 'key', 'owner'],
  recertify: ['tenant', 'key'],
  show: ['tenant', 'key'],
  list: ['tenant'],
};

/** Parses `args` (after `admin agent`). Undefined: print the usage. */
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
    // The instructions hash comes from exactly one source: the hash, or the file to hash.
    const sources = ['instructions-sha256', 'instructions-file'].filter((k) => k in found).length;
    if (command === 'register' && sources !== 1) return undefined;
    if (sources > 1) return undefined;
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
const list = (value: string | undefined): string[] | undefined =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');

async function instructionsHash(values: Values): Promise<string | undefined> {
  const file = opt(values, 'instructions-file');
  if (file === undefined) return opt(values, 'instructions-sha256');
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

async function ownerId(scope: TenantScope, email: string, ctx: CliContext) {
  const user = await scope.users.getByEmail(email);
  if (!user) ctx.stderr(t('cli.admin.user_not_found'));
  return user?.id;
}

const register: Scoped = async (scope, values, ctx) => {
  const owner = await ownerId(scope, str(values, 'owner'), ctx);
  if (owner === undefined) return EXIT.usage;
  const agent = await registerAgent(scope, {
    agentKey: str(values, 'key'),
    version: str(values, 'version'),
    ownerId: owner,
    modelRef: opt(values, 'model') ?? null,
    instructionsRef: str(values, 'instructions'),
    instructionsSha256: (await instructionsHash(values)) ?? '',
    allowedTools: list(opt(values, 'tools')) ?? [],
    maxAutonomy: str(values, 'max-autonomy'),
    approvedEnvironments: list(opt(values, 'environments')) ?? ['sandbox'],
  });
  return print(scope, agent, values, ctx, 'cli.admin.agent.registered');
};

const update: Scoped = async (scope, values, ctx) => {
  const hash = await instructionsHash(values);
  const tools = list(opt(values, 'tools'));
  const environments = list(opt(values, 'environments'));
  const input: UpdateAgent = {
    version: str(values, 'version'),
    ...(opt(values, 'model') === undefined ? {} : { modelRef: str(values, 'model') }),
    ...(opt(values, 'instructions') === undefined
      ? {}
      : { instructionsRef: str(values, 'instructions') }),
    ...(hash === undefined ? {} : { instructionsSha256: hash }),
    ...(tools === undefined ? {} : { allowedTools: tools }),
    ...(opt(values, 'max-autonomy') === undefined
      ? {}
      : { maxAutonomy: str(values, 'max-autonomy') }),
    ...(environments === undefined ? {} : { approvedEnvironments: environments }),
  };
  const agent = await updateAgent(scope, str(values, 'key'), input);
  return print(scope, agent, values, ctx, 'cli.admin.agent.updated');
};

function statusHandler(to: AgentStatus): Scoped {
  return async (scope, values, ctx) => {
    const reason = opt(values, 'reason');
    const agent = await changeAgentStatus(scope, str(values, 'key'), {
      to,
      ...(reason === undefined ? {} : { reason }),
    });
    return print(scope, agent, values, ctx, 'cli.admin.agent.status_changed');
  };
}

const owner: Scoped = async (scope, values, ctx) => {
  const id = await ownerId(scope, str(values, 'owner'), ctx);
  if (id === undefined) return EXIT.usage;
  const agent = await changeAgentOwner(scope, str(values, 'key'), id);
  return print(scope, agent, values, ctx, 'cli.admin.agent.owner_changed');
};

const recertify: Scoped = async (scope, values, ctx) => {
  const day = opt(values, 'date');
  const agent = await recertifyAgent(scope, str(values, 'key'), day === undefined ? {} : { day });
  return print(scope, agent, values, ctx, 'cli.admin.agent.recertified');
};

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
  register,
  update,
  activate: statusHandler('active'),
  suspend: statusHandler('suspended'),
  quarantine: statusHandler('quarantined'),
  retire: statusHandler('retired'),
  owner,
  recertify,
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
