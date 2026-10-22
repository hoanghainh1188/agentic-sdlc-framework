// `sdlc admin tool …`: the tool register through the API (task X04, ADR-M69 §2.2). A tool is
// activated or retired only by approvals: `approve --as <capacity>`; the approval that completes a
// set (the owner and Person B, or the owner and governance) changes the status. `--owner` takes a
// user ID or an e-mail address.
import { t } from '@sdlc/messages';

import {
  toolDetailSchema,
  toolListSchema,
  toolRoundSchema,
  toolSchema,
  type ToolRoundView,
  type ToolView,
} from '../api/schemas.js';
import { segment, type Values } from '../api/session.js';
import { say, show } from '../output.js';
import {
  opt,
  output,
  resolveUser,
  str,
  type AdminApiCommand,
  type AdminCall,
} from './admin-call.js';

const key = { key: { type: 'string' } } as const;
const CONFIG = {
  transport: { type: 'string' },
  image: { type: 'string' },
  'image-digest': { type: 'string' },
  permissions: { type: 'string' },
  'data-classes': { type: 'string' },
  'backing-services': { type: 'string' },
  model: { type: 'string' },
} as const;

const toolPath = (call: AdminCall): string => `/v1/admin/tools/${segment(str(call.values, 'key'))}`;

const list = (value: string | undefined): string[] | undefined =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

function configBody(values: Values): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    transport: opt(values, 'transport'),
    image_ref: opt(values, 'image'),
    image_digest: opt(values, 'image-digest'),
    permissions: list(opt(values, 'permissions')),
    allowed_data_classes: list(opt(values, 'data-classes')),
    backing_services: list(opt(values, 'backing-services')),
    model_ref: opt(values, 'model'),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

const stop = (to: 'suspend' | 'quarantine'): AdminApiCommand => ({
  options: { ...key, reason: { type: 'string' } },
  required: ['key', 'reason'],
  run: async (call) => {
    const tool = await call.client.post(`${toolPath(call)}/${to}`, toolSchema, {
      reason_code: str(call.values, 'reason'),
    });
    return output(call, tool, () => sayTool(call, 'cli.admin.tool.status_changed', tool));
  },
});

export const TOOL_COMMANDS: Readonly<Record<string, AdminApiCommand>> = {
  'tool register': {
    options: { ...key, ...CONFIG, version: { type: 'string' }, owner: { type: 'string' } },
    required: ['key', 'version', 'owner', 'transport', 'permissions', 'data-classes'],
    run: async (call) => {
      const tool = await call.client.post('/v1/admin/tools', toolSchema, {
        key: str(call.values, 'key'),
        version: str(call.values, 'version'),
        owner_id: await resolveUser(call, str(call.values, 'owner')),
        ...configBody(call.values),
      });
      return output(call, tool, () => sayTool(call, 'cli.admin.tool.registered', tool));
    },
  },
  'tool update': {
    options: { ...key, ...CONFIG, version: { type: 'string' } },
    required: ['key', 'version'],
    run: async (call) => {
      const tool = await call.client.patch(toolPath(call), toolSchema, {
        version: str(call.values, 'version'),
        ...configBody(call.values),
      });
      return output(call, tool, () => sayTool(call, 'cli.admin.tool.updated', tool));
    },
  },
  'tool approve': {
    options: {
      ...key,
      purpose: { type: 'string' },
      as: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['key', 'purpose', 'as'],
    run: async (call) => {
      const reason = opt(call.values, 'reason');
      const round = await call.client.post(`${toolPath(call)}/approvals`, toolRoundSchema, {
        purpose: str(call.values, 'purpose'),
        as: str(call.values, 'as'),
        ...(reason === undefined ? {} : { reason_code: reason }),
      });
      return output(call, round, () => {
        say(call.ctx, 'cli.admin.tool.approval', {
          key: round.tool.key,
          version: round.tool.version,
          purpose: round.purpose,
          capacity: str(call.values, 'as'),
          missing: missingText(round),
        });
        if (round.completed) sayTool(call, 'cli.admin.tool.status_changed', round.tool);
      });
    },
  },
  'tool suspend': stop('suspend'),
  'tool quarantine': stop('quarantine'),
  'tool owner': {
    options: { ...key, owner: { type: 'string' } },
    required: ['key', 'owner'],
    run: async (call) => {
      const tool = await call.client.put(`${toolPath(call)}/owner`, toolSchema, {
        owner_id: await resolveUser(call, str(call.values, 'owner')),
      });
      return output(call, tool, () => sayTool(call, 'cli.admin.tool.owner_changed', tool));
    },
  },
  'tool recertify': {
    options: { ...key, date: { type: 'string' } },
    required: ['key'],
    run: async (call) => {
      const day = opt(call.values, 'date');
      const tool = await call.client.post(`${toolPath(call)}/recertify`, toolSchema, {
        ...(day === undefined ? {} : { day }),
      });
      return output(call, tool, () => sayTool(call, 'cli.admin.tool.recertified', tool));
    },
  },
  'tool show': {
    options: key,
    required: ['key'],
    run: async (call) => {
      const tool = await call.client.get(toolPath(call), toolDetailSchema);
      return output(call, tool, () => {
        say(call.ctx, 'cli.admin.tool.detail', text(tool));
        for (const round of tool.rounds) {
          say(call.ctx, 'cli.admin.tool.round', {
            purpose: round.purpose,
            sets: round.sets.map((set) => set.join(' + ')).join(' | ') || '-',
            missing: missingText(round),
          });
        }
      });
    },
  },
  'tool list': {
    options: {},
    required: [],
    run: async (call) => {
      const all = await call.client.get('/v1/admin/tools', toolListSchema);
      return output(call, all, () => {
        if (all.items.length === 0) say(call.ctx, 'cli.admin.tool.none');
        for (const tool of all.items) say(call.ctx, 'cli.admin.tool.line', text(tool));
      });
    },
  },
};

/** What a round still needs: the missing capacities of each set, or `-` when one is complete. */
function missingText(round: ToolRoundView): string {
  if (round.missing.some((set) => set.length === 0)) return '-';
  return round.missing.map((set) => set.join(' + ')).join(' | ') || '-';
}

function sayTool(call: AdminCall, msg: Parameters<typeof say>[1], tool: ToolView): void {
  say(call.ctx, msg, { key: tool.key, version: tool.version, status: tool.status });
}

/** Message parameters: lists joined, missing values as `-`, the overdue flag as catalog text. */
function text(tool: ToolView): Record<string, string> {
  return {
    key: tool.key,
    code: tool.code,
    id: tool.id,
    version: tool.version,
    status: tool.status,
    owner_id: tool.owner_id,
    transport: tool.transport,
    image: show(tool.image_ref),
    digest: show(tool.image_digest),
    permissions: tool.permissions.join(',') || '-',
    data_classes: tool.allowed_data_classes.join(',') || '-',
    backing_services: tool.backing_services.join(',') || '-',
    model: show(tool.model_ref),
    recertified: show(tool.last_recertified_at),
    due: show(tool.recertification_due_on),
    overdue: tool.overdue ? t('cli.admin.tool.overdue_flag') : '',
  };
}
