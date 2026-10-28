// `sdlc admin project apply --file project.yaml [--dry-run] [--yes]` (task V17, QUESTIONS #617):
// a project and its team from one file, instead of about 15 `sdlc admin` commands (deploy README
// steps 9–12). Order: read and check the file → look up each GitHub login's numeric ID → read the
// platform's state → check the whole file, M21 included, against the file and the bindings
// already in the database → show the changes → confirm → one API call per change → print, per
// person, the commands that stay theirs. A refused file writes nothing; `--dry-run` writes
// nothing; a second run with the same file finds nothing to change.
import path from 'node:path';

import { t, type MessageKey } from '@sdlc/messages';

import { apiIo, CommandExit } from '../api/session.js';
import { EXIT } from '../context.js';
import { say, sayError, toJson } from '../output.js';
import { type AdminApiCommand, type AdminCall } from './admin-call.js';
import { applyWrites, ApplyStopped } from './project-apply/apply.js';
import { readProjectFile, type Refusal } from './project-apply/file.js';
import { githubApiUrl, lookupGithubLogin } from './project-apply/github.js';
import { planChanges, type GithubAccount, type Note, type Write } from './project-apply/plan.js';
import { OPERATOR, remainingWork, type Todo } from './project-apply/remaining.js';
import { readState } from './project-apply/state.js';

export const PROJECT_APPLY_COMMAND: AdminApiCommand = {
  options: {
    file: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
  required: ['file'],
  run: applyProjectFile,
};

async function applyProjectFile(call: AdminCall): Promise<number> {
  const { ctx } = call;
  const file = path.resolve(ctx.cwd ?? process.cwd(), String(call.values.file));
  const read = await readProjectFile(file);
  if (!read.ok) return refuse(call, read.refusals);
  const { checked } = read;
  const accounts = new Map<string, GithubAccount>();
  const refusals: Refusal[] = [];
  const base = githubApiUrl(ctx.env);
  if (base === undefined) return refuse(call, [{ key: 'cli.admin.apply.github_url', params: {} }]);
  for (const person of checked.file.team) {
    const found = await lookupGithubLogin(apiIo(ctx).fetch, base, person.github_login);
    if (found.kind === 'found') accounts.set(person.email.toLowerCase(), found);
    else
      refusals.push({ key: GITHUB_REFUSALS[found.kind], params: { login: person.github_login } });
  }
  const state = await readState(call.client, checked.file);
  const plan = planChanges(checked, state, accounts);
  if (!plan.ok || refusals.length > 0) {
    return refuse(call, [...refusals, ...(plan.ok ? [] : plan.refusals)]);
  }
  const todos = remainingWork(checked, state, plan.writes, plan.notes);
  const github = checked.file.team.map((person) => ({
    email: person.email,
    login: accounts.get(person.email.toLowerCase())?.login ?? person.github_login,
    id: accounts.get(person.email.toLowerCase())?.id ?? '-',
  }));
  const dryRun = call.values['dry-run'] === true;
  const report = (applied: boolean): number => {
    if (call.json) {
      ctx.stdout(
        toJson({
          project: checked.file.project.slug,
          dry_run: dryRun,
          github,
          changes: plan.writes,
          notes: plan.notes,
          applied,
          remaining: todos,
        }),
      );
    } else {
      if (applied) say(ctx, 'cli.admin.apply.applied', { count: plan.writes.length });
      sayTodos(call, todos);
    }
    return EXIT.ok;
  };
  if (!call.json) {
    say(ctx, 'cli.admin.apply.github_header');
    for (const line of github) say(ctx, 'cli.admin.apply.github_line', line);
    sayPlan(call, checked.file.project.slug, plan.writes, plan.notes);
  }
  if (plan.writes.length === 0 || dryRun) {
    if (!call.json && plan.writes.length > 0) say(ctx, 'cli.admin.apply.dry_run');
    return report(false);
  }
  await confirm(call);
  try {
    await applyWrites(call.client, checked, state, plan.writes);
  } catch (error) {
    if (!(error instanceof ApplyStopped)) throw error;
    sayError(ctx, 'cli.admin.apply.stopped', {
      number: error.done + 1,
      count: plan.writes.length,
    });
    throw error.failure;
  }
  return report(true);
}

const GITHUB_REFUSALS: Readonly<Record<'unknown' | 'not_a_person' | 'failed', MessageKey>> = {
  unknown: 'cli.admin.apply.github_unknown',
  not_a_person: 'cli.admin.apply.github_not_a_person',
  failed: 'cli.admin.apply.github_failed',
};

function refuse(call: AdminCall, refusals: readonly Refusal[]): number {
  for (const refusal of refusals) sayError(call.ctx, refusal.key, refusal.params);
  sayError(call.ctx, 'cli.admin.apply.refused');
  return EXIT.failed;
}

/** The operator types `yes`; `--yes` skips the question (scripts). Without a terminal: refused. */
async function confirm(call: AdminCall): Promise<void> {
  if (call.values.yes === true) return;
  const io = apiIo(call.ctx);
  if (!io.stdinIsTTY) {
    sayError(call.ctx, 'cli.admin.apply.needs_terminal');
    throw new CommandExit(EXIT.usage);
  }
  const answer = await io.readHiddenLine(t('cli.admin.apply.confirm'));
  if (answer.trim().toLowerCase() !== 'yes') {
    sayError(call.ctx, 'cli.admin.apply.not_confirmed');
    throw new CommandExit(EXIT.failed);
  }
}

function sayPlan(
  call: AdminCall,
  project: string,
  writes: readonly Write[],
  notes: readonly Note[],
): void {
  const { ctx } = call;
  if (writes.length === 0) say(ctx, 'cli.admin.apply.nothing', { project });
  else say(ctx, 'cli.admin.apply.plan_header', { project, count: writes.length });
  for (const write of writes) {
    switch (write.kind) {
      case 'project_create':
        say(ctx, 'cli.admin.apply.change.project_create', {
          project: write.body.slug ?? project,
          repo: write.body.repo_full_name ?? '-',
        });
        break;
      case 'project_update':
        for (const diff of write.diffs) {
          say(ctx, 'cli.admin.apply.change.project_update', { email: project, ...diff });
        }
        break;
      case 'user_update':
        for (const diff of write.diffs) {
          say(ctx, 'cli.admin.apply.change.user_update', { email: write.email, ...diff });
        }
        break;
      case 'user_create':
        say(ctx, 'cli.admin.apply.change.user_create', { email: write.email, name: write.name });
        break;
      case 'identity_link':
        say(ctx, 'cli.admin.apply.change.identity_link', {
          email: write.email,
          login: write.login,
          id: write.githubId,
        });
        break;
      case 'role_grant':
        say(ctx, 'cli.admin.apply.change.role_grant', { email: write.email, role: write.role });
        break;
      case 'agent_register':
        say(ctx, 'cli.admin.apply.change.agent_register', { key: write.key, owner: write.owner });
        break;
      case 'config_set':
        say(ctx, 'cli.admin.apply.change.config_set', { version: write.expectedVersion });
        break;
    }
  }
  for (const note of notes) {
    if (note.kind === 'agent_differs') {
      for (const diff of note.diffs)
        say(ctx, 'cli.admin.apply.note.agent_differs', { key: note.key, ...diff });
    } else if (note.kind === 'role_self') {
      say(ctx, 'cli.admin.apply.note.role_self', { email: note.email, role: note.role });
    } else {
      say(ctx, 'cli.admin.apply.note.role_extra', { email: note.who, role: note.role });
    }
  }
}

function sayTodos(call: AdminCall, todos: readonly Todo[]): void {
  if (todos.length === 0) return;
  say(call.ctx, 'cli.admin.apply.todo.header');
  const people = [...new Set(todos.map((todo) => todo.who))].sort((a, b) =>
    a === OPERATOR ? -1 : b === OPERATOR ? 1 : 0,
  );
  for (const who of people) {
    if (who === OPERATOR) say(call.ctx, 'cli.admin.apply.todo.who_operator');
    else say(call.ctx, 'cli.admin.apply.todo.who', { email: who });
    for (const todo of todos.filter((item) => item.who === who))
      say(call.ctx, todo.key, todo.params);
  }
}
