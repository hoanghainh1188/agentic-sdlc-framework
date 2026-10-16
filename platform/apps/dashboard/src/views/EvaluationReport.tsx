// The report of an evaluation (task L06, design/ADR-M83 §2.2–§2.4; QUESTIONS #465: dashboard
// first). Read-only, for a manager: plain words, every rate with its 95% interval, a difference only
// when the API's single test found one, recommendations as proposals for the agent register.
// Numbers and codes only: never a prompt, a task text or a diff.
import type { EvaluationReportView } from '@sdlc/api-schemas';

import { readEvaluationReport } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { Show, Txt } from '../components/common.js';
import { t } from '../i18n.js';
import {
  comparisonMessage,
  percent,
  realRunsState,
  recommendationMessage,
  withInterval,
} from '../model/report.js';

export function EvaluationReport({ code }: { readonly code: string }) {
  const { result } = useApi((signal) => readEvaluationReport(code, { signal }), [code]);
  return (
    <section class="report" aria-labelledby="report-title">
      <h2 id="report-title">{t('dashboard.eval.report.title')}</h2>
      <Show loaded={result}>{(report) => <ReportBody report={report} />}</Show>
    </section>
  );
}

function ReportBody({ report }: { readonly report: EvaluationReportView }) {
  return (
    <>
      <p class={report.final ? 'sub' : 'notice'}>
        {t(report.final ? 'dashboard.eval.report.final' : 'dashboard.eval.report.not_final', {
          results: report.results,
        })}
      </p>
      <p class="sub">{t('dashboard.eval.report.how_to_read')}</p>
      <Configurations rows={report.configurations} />
      <h3>{t('dashboard.eval.report.comparisons')}</h3>
      {report.comparisons.length === 0 ? (
        <p class="muted">{t('dashboard.eval.report.no_comparisons')}</p>
      ) : (
        <ul class="report-list">
          {report.comparisons.map((c) => {
            const m = comparisonMessage(c);
            return <li key={`${c.a}|${c.b}`}>{t(m.key, m.params)}</li>;
          })}
        </ul>
      )}
      <Recommendations report={report} />
      <RealRuns real={report.real_runs} />
    </>
  );
}

function Configurations({ rows }: { readonly rows: EvaluationReportView['configurations'] }) {
  if (rows.length === 0) return <p class="muted">{t('dashboard.eval.report.no_results')}</p>;
  return (
    <div class="table-wrap">
      <table class="report-table">
        <caption class="visually-hidden">{t('dashboard.eval.report.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('dashboard.eval.report.col.configuration')}</th>
            <th scope="col">{t('dashboard.eval.report.col.runs')}</th>
            <th scope="col">{t('dashboard.eval.report.col.resolved')}</th>
            <th scope="col">{t('dashboard.eval.report.col.pass_at_k')}</th>
            <th scope="col">{t('dashboard.eval.report.col.pass_hat_k')}</th>
            <th scope="col">{t('dashboard.eval.report.col.ci_first_try')}</th>
            <th scope="col">{t('dashboard.eval.report.col.stopped_at_cap')}</th>
            <th scope="col">{t('dashboard.eval.report.col.scope_breaches')}</th>
            <th scope="col">{t('dashboard.eval.report.col.cost_per_run')}</th>
            <th scope="col">{t('dashboard.eval.report.col.cost_per_resolved')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.configuration}>
              <th scope="row">
                <span class="mono">
                  <Txt value={c.configuration} />
                </span>
                <span class="sub">
                  <Txt value={c.model} />
                </span>
              </th>
              <td class="num">
                {t('dashboard.eval.report.runs_value', { runs: c.runs, tasks: c.tasks })}
              </td>
              <td class="num">{withInterval(c.resolved)}</td>
              <td class="num">{`${percent(c.pass_at_k)} (k=${String(c.k)})`}</td>
              <td class="num">{percent(c.pass_hat_k)}</td>
              <td class="num">{percent(c.ci_first_try)}</td>
              <td class="num">{c.stopped_at_cap}</td>
              <td class="num">{c.scope_breaches}</td>
              <td class="num">{t('dashboard.eval.usd', { amount: c.cost_per_run_usd })}</td>
              <td class="num">
                {c.cost_per_resolved_usd === null
                  ? '—'
                  : t('dashboard.eval.usd', { amount: c.cost_per_resolved_usd })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Recommendations({ report }: { readonly report: EvaluationReportView }) {
  return (
    <>
      <h3>{t('dashboard.eval.report.recommendations')}</h3>
      {report.recommendations.length === 0 ? (
        <p class="muted">{t('dashboard.eval.report.no_recommendation')}</p>
      ) : (
        <>
          <ul class="report-list">
            {report.recommendations.map((rec, index) => {
              const m = recommendationMessage(rec);
              return (
                <li key={`${rec.rule}|${rec.configuration}|${String(index)}`}>
                  {m === undefined ? <Txt value={rec.rule} /> : t(m.key, m.params)}
                </li>
              );
            })}
          </ul>
          <p class="notice">{t('eval.recommendation.register_note')}</p>
        </>
      )}
    </>
  );
}

function RealRuns({ real }: { readonly real: EvaluationReportView['real_runs'] }) {
  const state = realRunsState(real);
  return (
    <>
      <h3>{t('dashboard.eval.report.real_runs')}</h3>
      {state === 'hidden' && <p class="muted">{t('dashboard.eval.report.real_runs_hidden')}</p>}
      {state === 'none' && <p class="muted">{t('dashboard.eval.report.real_runs_none')}</p>}
      {state === 'shown' && real !== null && real.available && (
        <ul class="report-list">
          {real.rows.map((row) => (
            <li key={`${row.project}|${row.agent}|${row.agent_version}|${row.model}`}>
              {t('dashboard.eval.report.real_run', {
                agent: row.agent,
                version: row.agent_version,
                model: row.model,
                runs: row.runs.total,
                ci: `${String(row.ci.first_try_passed)}/${String(row.ci.first_try_total)}`,
                merged: row.merged.intents,
                cost_per_run: row.cost.per_run_usd ?? '—',
              })}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
