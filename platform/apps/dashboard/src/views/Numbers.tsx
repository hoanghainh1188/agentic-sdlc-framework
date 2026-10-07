// Cost and gate waiting times per project (U01 AC4; E04, E06; the trial measures of
// design/M-E-TRIAL-PLAN.md §7.1). Default ranges are the API's: the current month for cost, the
// last 30 days for gate times. The whole tenant is for tenant admins (the API decides).
import type { CostReportView, GateMetricsView, Me } from '@sdlc/api-schemas';

import { readCost, readGateMetrics } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { Bar, Duration, Empty, Show, Txt, When } from '../components/common.js';
import { LOCALE, t } from '../i18n.js';
import { costBars, gateWaitBars, groupDigits, roundUsd, waitScale } from '../model/numbers.js';
import { href } from '../router.js';
import { ProjectFilter, projectsOf } from './filters.js';

const GROUPS = ['intent', 'model', 'status', 'project'] as const;
type Group = (typeof GROUPS)[number];

const GROUP_KEYS: Readonly<Record<Group, string>> = {
  intent: 'dashboard.numbers.by_intent',
  model: 'dashboard.numbers.by_model',
  status: 'dashboard.numbers.by_status',
  project: 'dashboard.numbers.by_project',
};

export function Numbers({ me, query }: { readonly me: Me; readonly query: URLSearchParams }) {
  const projects = projectsOf(me);
  const asked = query.get('project') ?? undefined;
  // A person who is not a tenant admin always looks at one project.
  const project =
    asked !== undefined && projects.includes(asked)
      ? asked
      : me.tenant_admin === true
        ? undefined
        : projects[0];
  const groups = GROUPS.filter((g) => g !== 'project' || project === undefined);
  const askedGroup = query.get('by') as Group | null;
  const by: Group = askedGroup !== null && groups.includes(askedGroup) ? askedGroup : groups[0]!;
  const go = (next: { project?: string | undefined; by?: Group | undefined }) => {
    window.location.hash = href('numbers', {
      project: 'project' in next ? next.project : project,
      by: next.by ?? by,
    });
  };

  return (
    <section class="screen" aria-labelledby="numbers-title">
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.numbers.eyebrow')}</p>
          <h1 id="numbers-title">{t('dashboard.numbers.title')}</h1>
        </div>
        <div class="toolbar">
          <ProjectFilter
            projects={projects}
            value={project}
            onChange={(slug) => go({ project: slug, by: undefined })}
            allLabelKey={
              me.tenant_admin === true ? 'dashboard.filter.whole_tenant' : 'dashboard.filter.pick'
            }
          />
        </div>
      </div>
      {project === undefined && me.tenant_admin !== true ? (
        <Empty messageKey="dashboard.numbers.no_project" />
      ) : (
        <>
          <GateTimes project={project} />
          <Cost project={project} by={by} groups={groups} onBy={(g) => go({ by: g })} />
        </>
      )}
    </section>
  );
}

function GateTimes({ project }: { readonly project: string | undefined }) {
  const { result } = useApi((signal) => readGateMetrics({ project }, { signal }), [project]);
  return (
    <section class="panel" aria-labelledby="gates-title">
      <h2 id="gates-title">{t('dashboard.numbers.gates_title')}</h2>
      <Show loaded={result}>{(metrics) => <GateTable metrics={metrics.metrics} />}</Show>
    </section>
  );
}

function GateTable({ metrics }: { readonly metrics: GateMetricsView }) {
  const bars = gateWaitBars(metrics);
  if (bars.length === 0) return <Empty messageKey="dashboard.numbers.gates_empty" />;
  const scale = waitScale(bars);
  return (
    <>
      <p class="asof">
        {t('dashboard.numbers.range')} <When iso={metrics.from} /> – <When iso={metrics.to} /> ·{' '}
        {t('dashboard.numbers.wall_clock')}
      </p>
      {metrics.truncated && <p class="notice">{t('dashboard.numbers.truncated')}</p>}
      <div class="table-wrap">
        <table class="chart-table">
          <thead>
            <tr>
              <th scope="col">{t('dashboard.col.gate')}</th>
              <th scope="col">{t('dashboard.col.avg_wait')}</th>
              <th scope="col" class="chart-col">
                {t('dashboard.col.wait_chart')}
              </th>
              <th scope="col">{t('dashboard.col.p90')}</th>
              <th scope="col">{t('dashboard.col.max')}</th>
              <th scope="col">{t('dashboard.col.decided')}</th>
              <th scope="col">{t('dashboard.col.open')}</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((bar) => (
              <tr key={`${bar.project}-${bar.gate}`}>
                <th scope="row">
                  <span class="mono">
                    <Txt value={bar.gate} />
                  </span>
                  <span class="sub">
                    <Txt value={bar.project} />
                  </span>
                </th>
                <td>
                  <Duration seconds={bar.avgSeconds} />
                </td>
                <td class="chart-col">
                  <Bar
                    value={(bar.avgSeconds ?? 0) / scale}
                    marker={bar.p90Seconds === null ? undefined : bar.p90Seconds / scale}
                    tone="accent"
                    label={t('dashboard.numbers.wait_bar', { gate: bar.gate })}
                  />
                </td>
                <td>
                  <Duration seconds={bar.p90Seconds} />
                </td>
                <td>
                  <Duration seconds={bar.maxSeconds} />
                </td>
                <td class="num">
                  {bar.decided}
                  {bar.autoPassed > 0 && (
                    <span class="sub">
                      {t('dashboard.numbers.auto_passed', { count: bar.autoPassed })}
                    </span>
                  )}
                </td>
                <td class="num">
                  {bar.openCount}
                  {bar.oldestOpenSeconds !== null && (
                    <span class="sub">
                      {t('dashboard.numbers.oldest')} <Duration seconds={bar.oldestOpenSeconds} />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Cost({
  project,
  by,
  groups,
  onBy,
}: {
  readonly project: string | undefined;
  readonly by: Group;
  readonly groups: readonly Group[];
  readonly onBy: (g: Group) => void;
}) {
  const { result } = useApi((signal) => readCost({ project, by }, { signal }), [project, by]);
  return (
    <section class="panel" aria-labelledby="cost-title">
      <div class="panel-head">
        <h2 id="cost-title">{t('dashboard.numbers.cost_title')}</h2>
        <div class="segmented" role="group" aria-label={t('dashboard.numbers.group_label')}>
          {groups.map((g) => (
            <button key={g} type="button" aria-pressed={g === by} onClick={() => onBy(g)}>
              {t(GROUP_KEYS[g])}
            </button>
          ))}
        </div>
      </div>
      <Show loaded={result}>{(cost) => <CostTable report={cost.report} />}</Show>
    </section>
  );
}

function CostTable({ report }: { readonly report: CostReportView }) {
  const bars = costBars(report);
  const totals = report.totals;
  return (
    <>
      <dl class="headline">
        <div>
          <dt>{t('dashboard.numbers.total_cost')}</dt>
          <dd class="headline-big">${roundUsd(totals.cost_usd)}</dd>
        </div>
        <div>
          <dt>{t('dashboard.numbers.wasted_cost')}</dt>
          <dd class="headline-warn">${roundUsd(totals.wasted_cost_usd)}</dd>
        </div>
        <div>
          <dt>{t('dashboard.numbers.calls')}</dt>
          <dd>{new Intl.NumberFormat(LOCALE).format(totals.calls)}</dd>
        </div>
        <div>
          <dt>{t('dashboard.numbers.tokens')}</dt>
          <dd>
            {groupDigits(
              (BigInt(totals.input_tokens) + BigInt(totals.output_tokens)).toString(),
              LOCALE,
            )}
          </dd>
        </div>
      </dl>
      <p class="asof">
        {t('dashboard.numbers.range')} <When iso={report.from} /> – <When iso={report.to} /> ·{' '}
        {t('dashboard.numbers.freshness', { runs: report.freshness.runs_in_progress })}{' '}
        <When iso={report.freshness.last_recorded_at} />
      </p>
      {report.truncated && <p class="notice">{t('dashboard.numbers.truncated')}</p>}
      {bars.length === 0 ? (
        <Empty messageKey="dashboard.numbers.cost_empty" />
      ) : (
        <div class="table-wrap">
          <table class="chart-table">
            <thead>
              <tr>
                <th scope="col">{t('dashboard.col.key')}</th>
                <th scope="col">{t('dashboard.col.cost')}</th>
                <th scope="col" class="chart-col">
                  {t('dashboard.col.cost_chart')}
                </th>
                <th scope="col">{t('dashboard.col.wasted')}</th>
                <th scope="col">{t('dashboard.col.calls')}</th>
                <th scope="col">{t('dashboard.col.tokens')}</th>
              </tr>
            </thead>
            <tbody>
              {bars.map((bar) => (
                <tr key={bar.key ?? '-'}>
                  <th scope="row" class="mono">
                    <Txt value={bar.key} />
                  </th>
                  <td class="num">${roundUsd(bar.costUsd)}</td>
                  <td class="chart-col">
                    <Bar
                      value={bar.costShare}
                      marker={bar.wastedShare > 0 ? bar.wastedShare : undefined}
                      tone="ink"
                      label={t('dashboard.numbers.cost_bar')}
                    />
                  </td>
                  <td class="num">${roundUsd(bar.wastedUsd)}</td>
                  <td class="num">{bar.calls}</td>
                  <td class="num">{groupDigits(bar.tokens, LOCALE)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
