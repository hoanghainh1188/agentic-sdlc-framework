// One evaluation (task L05, design/ADR-M82 §2.7): its status, its runs by status, what it spent
// of its budget, and the plan it came from. The full report and recommendations come with L06.
import { readEvaluation } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { Bar, codeClass, Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import { micros, RUN_STATE_KEYS } from '../model/evaluations.js';
import { planHref } from '../router.js';
import { Facts } from './EvalPlan.js';

const RUN_STATES = ['queued', 'running', 'preempted', 'scored', 'failed', 'cancelled'] as const;

export function Evaluation({ code }: { readonly code: string }) {
  const { result, reload } = useApi((signal) => readEvaluation(code, { signal }), [code]);
  return (
    <section class="screen" aria-labelledby="evaluation-title">
      <Show loaded={result}>
        {(e) => {
          const budget = micros(e.budget_usd) ?? 0n;
          const spent = micros(e.spent_usd ?? '0') ?? 0n;
          const share = budget === 0n ? 0 : Math.min(1, Number((spent * 1000n) / budget) / 1000);
          const runs = e.runs;
          return (
            <>
              <div class="screen-head">
                <div>
                  <p class="eyebrow">
                    {e.plan_id !== null ? (
                      <a href={planHref(e.plan_id)}>{t('dashboard.eval.from_plan')}</a>
                    ) : (
                      t('dashboard.eval.from_operator')
                    )}
                  </p>
                  <h1 id="evaluation-title" class="mono">
                    <Txt value={e.code} />
                  </h1>
                  <p class="sub">
                    <span class={`chip ${codeClass('evaluation', e.status)}`}>
                      <Txt value={e.status} />
                    </span>{' '}
                    {e.stop_reason !== null && <Txt value={e.stop_reason} />}
                  </p>
                </div>
                <div class="toolbar">
                  <button type="button" class="button button-quiet" onClick={reload}>
                    {t('dashboard.refresh')}
                  </button>
                </div>
              </div>
              <h2>{t('dashboard.eval.spend')}</h2>
              <p>
                {t('dashboard.eval.spend_value', {
                  spent: e.spent_usd ?? '0',
                  budget: e.budget_usd,
                })}
              </p>
              <Bar value={share} label={t('dashboard.eval.spend')} />
              <h2>{t('dashboard.eval.runs')}</h2>
              {runs === undefined ? (
                <p class="muted">—</p>
              ) : (
                <Facts rows={RUN_STATES.map((state) => [t(RUN_STATE_KEYS[state]), runs[state]])} />
              )}
              <Facts
                rows={[
                  [t('dashboard.eval.facts.started'), <When iso={e.created_at} />],
                  [t('dashboard.eval.facts.finished'), <When iso={e.finished_at} />],
                  [t('dashboard.eval.facts.tasks'), <Txt value={e.task_ids.join(', ')} />],
                  [
                    t('dashboard.eval.configurations'),
                    <Txt value={e.configuration_ids.join(', ')} />,
                  ],
                ]}
              />
              <p class="sub">{t('dashboard.eval.report_later')}</p>
            </>
          );
        }}
      </Show>
    </section>
  );
}
