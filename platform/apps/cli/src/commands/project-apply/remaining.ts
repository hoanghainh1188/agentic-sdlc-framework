// What `adlc admin project apply` leaves to people, per person (task V17 AC5, QUESTIONS #617 (5)):
// tokens stay with `adlc admin token issue` (shown once), the agent's owner and Person B each
// approve the agent (handbook Ch.20 §20.5b), Person A writes the project AI record, and a role the
// operator would give themselves goes to another admin or the platform operator.
import type { MessageKey } from '@sdlc/messages';

import type { CheckedFile } from './file.js';
import type { Note, Write } from './plan.js';
import type { CurrentState } from './state.js';

/** `operator`: the person who ran the command. Otherwise the e-mail address of a team member. */
export interface Todo {
  readonly who: string;
  readonly key: MessageKey;
  readonly params: Readonly<Record<string, string>>;
}

export const OPERATOR = 'operator';

export function remainingWork(
  checked: CheckedFile,
  state: CurrentState,
  writes: readonly Write[],
  notes: readonly Note[],
): Todo[] {
  const { file } = checked;
  const project = file.project.slug;
  const todos: Todo[] = [];
  const add = (who: string, key: MessageKey, params: Record<string, string> = {}): void => {
    todos.push({ who, key, params });
  };
  const created = writes.flatMap((w) => (w.kind === 'user_create' ? [w.email] : []));
  for (const email of created) add(OPERATOR, 'cli.admin.apply.todo.token_issue', { email });
  for (const note of notes) {
    if (note.kind === 'role_self') {
      add(OPERATOR, 'cli.admin.apply.todo.role_by_other', {
        project,
        email: note.email,
        role: note.role,
      });
    }
    if (note.kind === 'agent_differs')
      add(OPERATOR, 'cli.admin.apply.todo.agent_update', { key: note.key });
  }
  if (notes.some((note) => note.kind === 'role_extra')) {
    add(OPERATOR, 'cli.admin.apply.todo.role_revoke', { project });
  }
  const proposed =
    writes.some((w) => w.kind === 'agent_register') || state.agent?.status === 'proposed';
  for (const person of file.team) {
    const email = person.email;
    if (created.includes(email)) add(email, 'cli.admin.apply.todo.login');
    if (file.agent && proposed && email.toLowerCase() === file.agent.owner.toLowerCase()) {
      add(email, 'cli.admin.apply.todo.approve_owner', { key: file.agent.key });
    }
    if (file.agent && proposed && person.roles.includes('person_b')) {
      add(email, 'cli.admin.apply.todo.approve_person_b', { key: file.agent.key });
    }
    if (state.aiRecord !== 'present' && person.roles.includes('person_a')) {
      add(email, 'cli.admin.apply.todo.ai_record', { project });
    }
  }
  return todos;
}
