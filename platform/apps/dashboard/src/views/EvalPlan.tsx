// One evaluation plan (task L05, design/ADR-M82 §2.7): what it runs, when, its budgets, its
// versions and evaluations. With a role in `access.eval_roles` (`can_change`) and a GitHub
// sign-in with actions on, the person asks for a run now (confirmed with a passkey), changes the
// plan, or archives it (final, asked twice). One status region says the result of the last action.
import type { EvalPlanView } from '@sdlc/api-schemas';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

import { ApiError } from '../api/client.js';
import { readEvalPlan } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { archiveEvalPlan, runEvalPlan } from '../api/writes.js';
import { codeClass, Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import {
  evalErrorKey,
  PLAN_STATUS_KEYS,
  WEEKDAY_KEYS,
  WHEN_KEYS,
  type PlanAction,
} from '../model/evaluations.js';
import { href, planHref } from '../router.js';
import { session } from '../session.js';
import { confirmWithPasskey, PasskeyCancelled } from './eval-step-up.js';
import { EvaluationTable } from './Evaluations.js';

type Notice = { readonly kind: 'ok' | 'error'; readonly key: string };

/** The catalog key of a failed action: the API's reason, a cancelled passkey, or a failure. */
export function actionErrorKey(error: unknown): string {
  if (error instanceof PasskeyCancelled) return 'dashboard.eval.error.cancelled';
  if (error instanceof ApiError) return evalErrorKey(error);
  return 'dashboard.eval.error.failed';
}

export function EvalPlan({ id }: { readonly id: string }) {
  const { result, reload } = useApi((signal) => readEvalPlan(id, { signal }), [id]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const act = async (work: PlanAction, done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      setNotice({ kind: 'ok', key: done });
      reload();
    } catch (error) {
      setNotice({ kind: 'error', key: actionErrorKey(error) });
    } finally {
      setBusy(false);
      setConfirmArchive(false);
    }
  };

  return (
    <section class="screen" aria-labelledby="plan-title">
      <Show loaded={result}>
        {(plan) => {
          const canWrite = plan.can_change && session.actions();
          return (
            <>
              <div class="screen-head">
                <div>
                  <p class="eyebrow">
                    <a href={href('evaluations', { project: plan.project.slug })}>
                      {t('dashboard.eval.title')}
                    </a>{' '}
                    · <Txt value={plan.project.slug} />
                  </p>
                  <h1 id="plan-title" class="mono">
                    <Txt value={plan.code} />
                  </h1>
                  <p class="sub">
                    <span class={`chip ${codeClass('plan', plan.status)}`}>
                      {t(PLAN_STATUS_KEYS[plan.status] ?? plan.status)}
                    </span>{' '}
                    {t('dashboard.eval.version', { version: plan.version })}
                  </p>
                </div>
                {canWrite && (
                  <div class="toolbar">
                    <button
                      type="button"
                      class="button"
                      disabled={busy || plan.run_requested_at !== null}
                      onClick={() =>
                        void act(async () => {
                          const answer = await confirmWithPasskey('eval_plan.run', {}, plan.id);
                          await runEvalPlan(plan.id, { step_up: answer });
                        }, 'dashboard.eval.run_requested')
                      }
                    >
                      {t('dashboard.eval.run_now')}
                    </button>
                    <a class="button button-quiet" href={planHref(plan.id, true)}>
                      {t('dashboard.eval.edit')}
                    </a>
                    {confirmArchive ? (
                      <button
                        type="button"
                        class="button button-danger"
                        disabled={busy}
                        onClick={() =>
                          void act(() => archiveEvalPlan(plan.id), 'dashboard.eval.archived')
                        }
                      >
                        {t('dashboard.eval.archive_confirm')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        class="button button-quiet"
                        disabled={busy}
                        onClick={() => setConfirmArchive(true)}
                      >
                        {t('dashboard.eval.archive')}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {/* One status region, always present; hidden while it has nothing to say. */}
              <p
                class={notice?.kind === 'ok' ? 'notice' : 'visually-hidden'}
                role="status"
                aria-live="polite"
              >
                {notice?.kind === 'ok' ? t(notice.key) : ''}
              </p>
              {notice?.kind === 'error' && (
                <p class="notice notice-error" role="alert">
                  {t(notice.key)}
                </p>
              )}
              <PlanFacts plan={plan} />
              <h2>{t('dashboard.eval.configurations')}</h2>
              <ul class="config-list">
                {plan.current.configurations.map((c) => (
                  <li key={c.id}>
                    <span class="mono">
                      <Txt value={c.id} />
                    </span>
                    <span class="sub">
                      {c.agent_key !== null
                        ? t('dashboard.eval.config.agent', { agent: c.agent_key })
                        : t('dashboard.eval.config.model', {
                            model: c.model ?? '',
                            provider: c.provider_type ?? '',
                          })}
                      {' · '}
                      {t('dashboard.eval.config.caps', {
                        iterations: c.max_iterations,
                        minutes: c.max_duration_min,
                      })}
                    </span>
                    {c.prompt !== null && (
                      <span class="sub mono">
                        {t('dashboard.eval.config.prompt', {
                          path: c.prompt.path,
                          sha: c.prompt.sha256.slice(0, 12),
                        })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <h2>{t('dashboard.eval.plan_evaluations')}</h2>
              <EvaluationTable rows={plan.evaluations} />
            </>
          );
        }}
      </Show>
    </section>
  );
}

/** A list of facts as label and value pairs (the layout of the intent screen). */
export function Facts({
  rows,
}: {
  readonly rows: readonly (readonly [string, ComponentChildren] | false)[];
}) {
  return (
    <dl class="facts">
      {rows
        .filter((row): row is readonly [string, ComponentChildren] => row !== false)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function PlanFacts({ plan }: { readonly plan: EvalPlanView }) {
  const c = plan.current;
  const when =
    c.trigger === 'schedule' && c.schedule !== null
      ? t(WHEN_KEYS[c.schedule.every === 'daily' ? 'daily' : 'weekly'], {
          hour: c.schedule.hour,
          weekday: t(WEEKDAY_KEYS[String(c.schedule.weekday ?? 1)] ?? ''),
        })
      : t(WHEN_KEYS[c.trigger === 'on_change' ? 'on_change' : 'once']);
  return (
    <Facts
      rows={[
        [t('dashboard.eval.facts.when'), when],
        [t('dashboard.eval.facts.next_run'), <When iso={plan.next_run_at} />],
        [
          t('dashboard.eval.facts.tasks'),
          t('dashboard.eval.facts.tasks_value', {
            set: c.task_set_version ?? t('dashboard.eval.project_task_set'),
            tasks: c.task_ids === null ? t('dashboard.eval.all_tasks') : c.task_ids.join(', '),
            runs: c.runs_per_task,
          }),
        ],
        [
          t('dashboard.eval.facts.budget'),
          t('dashboard.eval.facts.budget_value', {
            run: c.budget_per_run_usd,
            cap: c.monthly_cap_usd,
          }),
        ],
        [t('dashboard.eval.facts.data_class'), <Txt value={c.data_class} />],
        plan.pause_reason !== null && [
          t('dashboard.eval.facts.paused'),
          <>
            {t(`evaluation.error.${plan.pause_reason}`)} · <When iso={plan.paused_until} />
          </>,
        ],
        plan.last_refusal !== null && [
          t('dashboard.eval.facts.last_refusal'),
          <>
            {t(`evaluation.error.${plan.last_refusal}`)} · <When iso={plan.last_refusal_at} />
          </>,
        ],
      ]}
    />
  );
}
