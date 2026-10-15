// Evaluation plans of a project (task L05, design/ADR-M82 §2.7; QUESTIONS #465): what each plan
// does next, a run that waits for the worker, the last refusal, and the project's latest
// evaluations. A person with a role in `access.eval_roles` sees "New plan" (`can_change`, QUESTIONS
// #477) when the dashboard may write (a GitHub sign-in with actions on).
import type { Me } from '@sdlc/api-schemas';

import { readEvalPlans, readEvaluations } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { codeClass, Empty, Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import { PLAN_STATUS_KEYS } from '../model/evaluations.js';
import { evaluationHref, href, planHref } from '../router.js';
import { session } from '../session.js';
import { ProjectFilter, projectsOf } from './filters.js';

export function Evaluations({ me, query }: { readonly me: Me; readonly query: URLSearchParams }) {
  const projects = projectsOf(me);
  const asked = query.get('project') ?? undefined;
  const project = asked !== undefined && projects.includes(asked) ? asked : projects[0];
  const { result, reload } = useApi(
    async (signal) =>
      project === undefined
        ? null
        : Promise.all([readEvalPlans(project, { signal }), readEvaluations(project, { signal })]),
    [project],
  );

  return (
    <section class="screen" aria-labelledby="eval-title">
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.eval.eyebrow')}</p>
          <h1 id="eval-title">{t('dashboard.eval.title')}</h1>
        </div>
        <div class="toolbar">
          <ProjectFilter
            projects={projects}
            value={project}
            onChange={(slug) => {
              window.location.hash = href('evaluations', { project: slug });
            }}
            allLabelKey="dashboard.filter.pick"
          />
          <button type="button" class="button button-quiet" onClick={reload}>
            {t('dashboard.refresh')}
          </button>
        </div>
      </div>
      {project === undefined ? (
        <Empty messageKey="dashboard.eval.no_project" />
      ) : (
        <Show loaded={result}>
          {(data) => {
            if (data === null) return <Empty messageKey="dashboard.eval.no_project" />;
            const [plans, evaluations] = data;
            const canWrite = plans.can_change && session.actions();
            return (
              <>
                <div class="section-head">
                  <h2>{t('dashboard.eval.plans')}</h2>
                  {canWrite && (
                    <a class="button" href={href('evaluations/plans/new', { project })}>
                      {t('dashboard.eval.new_plan')}
                    </a>
                  )}
                </div>
                {plans.plans.length === 0 ? (
                  <Empty messageKey="dashboard.eval.no_plans" />
                ) : (
                  <div class="table-wrap">
                    <table class="eval-table">
                      <caption class="visually-hidden">{t('dashboard.eval.plans')}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('dashboard.eval.col.plan')}</th>
                          <th scope="col">{t('dashboard.eval.col.status')}</th>
                          <th scope="col">{t('dashboard.eval.col.next_run')}</th>
                          <th scope="col">{t('dashboard.eval.col.last_refusal')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plans.plans.map((p) => (
                          <tr key={p.id}>
                            <th scope="row">
                              <a class="mono" href={planHref(p.id)}>
                                <Txt value={p.code} />
                              </a>
                              <span class="sub">
                                {t('dashboard.eval.version', { version: p.version })}
                              </span>
                            </th>
                            <td data-label={t('dashboard.eval.col.status')}>
                              <span class={`chip ${codeClass('plan', p.status)}`}>
                                {t(PLAN_STATUS_KEYS[p.status] ?? p.status)}
                              </span>
                              {p.run_requested_at !== null && (
                                <span class="sub">{t('dashboard.eval.run_waiting')}</span>
                              )}
                            </td>
                            <td data-label={t('dashboard.eval.col.next_run')}>
                              <When iso={p.next_run_at} />
                            </td>
                            <td data-label={t('dashboard.eval.col.last_refusal')}>
                              {p.last_refusal === null ? (
                                <span class="muted">—</span>
                              ) : (
                                <span class="notice-inline">
                                  {t(`evaluation.error.${p.last_refusal}`)}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <h2>{t('dashboard.eval.latest')}</h2>
                <EvaluationTable rows={evaluations.evaluations} />
              </>
            );
          }}
        </Show>
      )}
    </section>
  );
}

/** A list of evaluations: code, status, budget, start. */
export function EvaluationTable({
  rows,
}: {
  readonly rows: readonly {
    readonly code: string;
    readonly status: string;
    readonly stop_reason: string | null;
    readonly budget_usd: string;
    readonly created_at: string;
  }[];
}) {
  if (rows.length === 0) return <Empty messageKey="dashboard.eval.no_evaluations" />;
  return (
    <div class="table-wrap">
      <table class="eval-table">
        <caption class="visually-hidden">{t('dashboard.eval.latest')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.eval.col.evaluation')}</th>
            <th scope="col">{t('dashboard.eval.col.status')}</th>
            <th scope="col">{t('dashboard.eval.col.budget')}</th>
            <th scope="col">{t('dashboard.eval.col.started')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.code}>
              <th scope="row">
                <a class="mono" href={evaluationHref(e.code)}>
                  <Txt value={e.code} />
                </a>
              </th>
              <td data-label={t('dashboard.eval.col.status')}>
                <span class={`chip ${codeClass('evaluation', e.status)}`}>
                  <Txt value={e.status} />
                </span>
                {e.stop_reason !== null && (
                  <span class="sub">
                    <Txt value={e.stop_reason} />
                  </span>
                )}
              </td>
              <td class="num" data-label={t('dashboard.eval.col.budget')}>
                {t('dashboard.eval.usd', { amount: e.budget_usd })}
              </td>
              <td data-label={t('dashboard.eval.col.started')}>
                <When iso={e.created_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
