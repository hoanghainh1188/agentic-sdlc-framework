// Posting escalation notices (D-08 B11, handbook Ch.6 §6.4–§6.5, design/ADR-M28 §2.5). The
// escalation clock and `raiseEscalation` record notices as codes (`escalation_notices`); the poller
// posts them after its replies, as one comment per escalation, kind and step on the intent's issue.
//
// - The text comes from the message catalog (NFR-08). It mentions the GitHub accounts of the
//   people who hold the notice's roles now (never producers of the change); logins are read when
//   the comment is posted and never stored.
// - Delivery follows the reply rules of ADR-M27 §2.4: at least once, after the commit, retried on
//   the next polls, given up after `maxReplyAttempts`. A notice of an intent with no issue is given
//   up at once (logged): there is nowhere to post it.
import type { GitHostAdapter, RepoRef } from '@sdlc/contracts';
import { GitHostError } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';

import type { Escalation, EscalationNotice } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** Catalog key of each notice kind (tested: every kind has one). */
export const ESCALATION_NOTICE_KEYS: Readonly<Record<string, MessageKey>> = {
  raised: 'escalation.notice.raised',
  reminder: 'escalation.notice.reminder',
  step_changed: 'escalation.notice.step_changed',
  ack_overdue: 'escalation.notice.ack_overdue',
  resolve_overdue: 'escalation.notice.resolve_overdue',
  incident_due: 'escalation.notice.incident_due',
};

/** GitHub logins: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type NoticeLogEvent =
  | 'notice.posted'
  | 'notice.failed'
  | 'notice.abandoned'
  | 'notice.no_issue'
  | 'notice.bookkeeping_failed';

export interface NoticeDeps {
  readonly gitHost: GitHostAdapter;
  readonly maxAttempts: number;
  readonly limit: number;
  readonly now: () => Date;
  readonly log: (
    level: 'info' | 'warn' | 'error',
    event: NoticeLogEvent,
    fields: Readonly<Record<string, string | number | boolean>>,
  ) => void;
}

function minuteUtc(at: Date | null): string {
  return at === null ? '—' : `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The Markdown body of one notice comment. A hidden marker names the escalation and kind. */
export function renderEscalationNotice(
  kind: string,
  escalation: Pick<
    Escalation,
    'code' | 'severity' | 'response_level' | 'current_step' | 'step_due_at' | 'resolve_due_at'
  >,
  step: string,
  mentions: readonly string[],
  locale?: string,
): string {
  const key = ESCALATION_NOTICE_KEYS[kind] ?? ESCALATION_NOTICE_KEYS.raised!;
  const who = mentions.length > 0 ? mentions.join(' ') : t('escalation.notice.nobody', {}, locale);
  const body = t(
    key,
    {
      code: escalation.code,
      severity: escalation.severity,
      level: escalation.response_level,
      step,
      mentions: who,
      due: minuteUtc(escalation.step_due_at),
      resolve_due: minuteUtc(escalation.resolve_due_at),
    },
    locale,
  );
  const footer = t('escalation.notice.footer', {}, locale);
  return `${body}\n\n${footer}\n\n<!-- sdlc-escalation ${escalation.code} ${kind} ${step} -->`;
}

/** `@login` of the active holders of `roles` on the project, producers left out. */
async function mentionsFor(
  scope: TenantScope,
  projectId: string,
  roles: readonly string[],
  producers: readonly string[],
): Promise<string[]> {
  const bindings = (await scope.roleBindings.listForProject(projectId)).filter(
    (b) => roles.includes(b.role) && !producers.includes(b.user_id),
  );
  const logins = new Set<string>();
  for (const userId of new Set(bindings.map((b) => b.user_id))) {
    const user = await scope.users.getById(userId);
    if (user?.status !== 'active') continue;
    for (const identity of await scope.userIdentities.listForUser(userId)) {
      if (identity.provider === 'github' && GITHUB_LOGIN.test(identity.external_login)) {
        logins.add(`@${identity.external_login}`);
      }
    }
  }
  return [...logins].sort();
}

interface NoticeGroup {
  readonly escalationId: string;
  readonly kind: string;
  readonly step: string;
  readonly notices: EscalationNotice[];
}

function groupNotices(notices: readonly EscalationNotice[]): NoticeGroup[] {
  const groups = new Map<string, NoticeGroup>();
  for (const notice of notices) {
    const key = `${notice.escalation_id}/${notice.kind}/${notice.step}`;
    const group = groups.get(key) ?? {
      escalationId: notice.escalation_id,
      kind: notice.kind,
      step: notice.step,
      notices: [],
    };
    group.notices.push(notice);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Posts the pending notices of a project, oldest first. */
export async function flushEscalationNotices(
  deps: NoticeDeps,
  scope: TenantScope,
  projectId: string,
  ref: RepoRef,
): Promise<{ posted: number; failed: number }> {
  const pending = await scope.escalationNotices.pendingForProject(projectId, deps.limit);
  let posted = 0;
  let failed = 0;
  for (const group of groupNotices(pending)) {
    const escalation = await scope.escalations.getById(group.escalationId);
    const intent = escalation ? await scope.intents.getById(escalation.intent_id) : undefined;
    const ids = group.notices.map((n) => n.id);
    const attempts = Math.max(...group.notices.map((n) => n.attempts)) + 1;
    const fields = {
      tenant_id: scope.tenantId,
      project_id: projectId,
      escalation_id: group.escalationId,
      kind: group.kind,
    };
    if (!escalation || !intent || intent.issue_number === null) {
      await bookkeeping(deps, scope, ids, { attempts, abandonAt: deps.now() }, fields);
      deps.log('warn', 'notice.no_issue', fields);
      continue;
    }
    let error: unknown;
    try {
      const roles = group.notices.map((n) => n.audience_role);
      const mentions = await mentionsFor(scope, projectId, roles, escalation.producer_ids);
      await deps.gitHost.createIssueComment(
        ref,
        intent.issue_number,
        renderEscalationNotice(group.kind, escalation, group.step, mentions),
      );
    } catch (caught) {
      error = caught ?? new Error('unknown');
    }
    if (error === undefined) {
      await bookkeeping(deps, scope, ids, { attempts, postedAt: deps.now() }, fields);
      posted += 1;
      deps.log('info', 'notice.posted', fields);
      continue;
    }
    const abandon = attempts >= deps.maxAttempts;
    await bookkeeping(
      deps,
      scope,
      ids,
      abandon ? { attempts, abandonAt: deps.now() } : { attempts },
      fields,
    );
    const code = error instanceof GitHostError ? error.code : 'unexpected';
    failed += 1;
    deps.log(abandon ? 'error' : 'warn', abandon ? 'notice.abandoned' : 'notice.failed', {
      ...fields,
      attempts,
      error: code,
    });
    // The Git host asks us to wait: the other notices would fail the same way.
    if (code === 'rate_limited') break;
  }
  return { posted, failed };
}

/** Bookkeeping never stops the other notices: a failure only means a notice may be posted again. */
async function bookkeeping(
  deps: NoticeDeps,
  scope: TenantScope,
  ids: readonly string[],
  result: { readonly attempts: number; readonly postedAt?: Date; readonly abandonAt?: Date },
  fields: Readonly<Record<string, string>>,
): Promise<void> {
  try {
    await scope.escalationNotices.markDelivery(ids, result);
  } catch {
    deps.log('error', 'notice.bookkeeping_failed', fields);
  }
}
