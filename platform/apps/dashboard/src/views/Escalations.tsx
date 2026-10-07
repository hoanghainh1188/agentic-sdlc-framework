// Open escalations (U01 AC4): severity, route, the role that holds the current step, and the
// acknowledge or resolve clock, overdue first. `freezes_intent` comes from the API (isFreezing).
import { readOpenEscalations } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { codeClass, Due, Empty, Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';
import { roleName } from '../labels.js';
import { escalationRows } from '../model/escalations.js';
import { intentHref } from '../router.js';

const STEP_KEYS: Readonly<Record<string, string>> = {
  owner: 'dashboard.esc.step_owner',
  backup: 'dashboard.esc.step_backup',
  governance: 'dashboard.esc.step_governance',
};

const CLOCK_KEYS = {
  acknowledge: 'dashboard.esc.clock_acknowledge',
  resolve: 'dashboard.esc.clock_resolve',
} as const;

export function Escalations() {
  const { result, reload } = useApi((signal) => readOpenEscalations(undefined, { signal }), []);
  return (
    <section class="screen" aria-labelledby="esc-screen-title">
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.esc.eyebrow')}</p>
          <h1 id="esc-screen-title">{t('dashboard.esc.title')}</h1>
        </div>
        <div class="toolbar">
          <button type="button" class="button button-quiet" onClick={reload}>
            {t('dashboard.refresh')}
          </button>
        </div>
      </div>
      <Show loaded={result}>
        {({ items, truncated }, at) => {
          const rows = escalationRows(items, at);
          if (rows.length === 0) return <Empty messageKey="dashboard.esc.empty" />;
          return (
            <>
              {truncated && <p class="notice">{t('dashboard.esc.truncated')}</p>}
              <div class="table-wrap">
                <table class="esc-table">
                  <caption class="visually-hidden">{t('dashboard.esc.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('dashboard.col.escalation')}</th>
                      <th scope="col">{t('dashboard.col.severity')}</th>
                      <th scope="col">{t('dashboard.col.route')}</th>
                      <th scope="col">{t('dashboard.col.holder')}</th>
                      <th scope="col">{t('dashboard.col.clock')}</th>
                      <th scope="col">{t('dashboard.col.intent')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const e = row.escalation;
                      return (
                        <tr
                          key={e.id}
                          class={`${codeClass('sev', e.severity)} due-row-${row.state}`}
                        >
                          <th scope="row">
                            <span class="mono">
                              <Txt value={e.code} />
                            </span>
                            <span class="sub">
                              <Txt value={e.trigger} /> · <Txt value={e.response_level} />
                              {e.freezes_intent && (
                                <span class="chip chip-warn">{t('dashboard.board.frozen')}</span>
                              )}
                            </span>
                          </th>
                          <td data-label={t('dashboard.col.severity')}>
                            <span class={`chip ${codeClass('sev-chip', e.severity)}`}>
                              <Txt value={e.severity} />
                            </span>
                          </td>
                          <td class="mono" data-label={t('dashboard.col.route')}>
                            <Txt value={e.route} />
                          </td>
                          <td data-label={t('dashboard.col.holder')}>
                            {roleName(e.step_role)}
                            <span class="sub">
                              {t(STEP_KEYS[e.current_step] ?? e.current_step)}
                            </span>
                          </td>
                          <td data-label={t('dashboard.col.clock')}>
                            <span class="sub">{t(CLOCK_KEYS[row.clock])}</span>
                            <Due iso={row.due} now={at} />
                            <span class="sub">
                              <When iso={row.due} />
                            </span>
                          </td>
                          <td data-label={t('dashboard.col.intent')}>
                            <a class="mono" href={intentHref(e.intent.code)}>
                              <Txt value={e.intent.code} />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </Show>
    </section>
  );
}
