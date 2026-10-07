// The audit check (U01 AC4, tenant admins): GET /v1/admin/audit/verify, on request.
import { useState } from 'preact/hooks';

import { readAuditCheck } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { Show } from '../components/common.js';
import { t } from '../i18n.js';

const REASON_KEYS: Readonly<Record<string, string>> = {
  seq_gap: 'dashboard.audit.reason_seq_gap',
  prev_hash_mismatch: 'dashboard.audit.reason_prev_hash_mismatch',
  hash_mismatch: 'dashboard.audit.reason_hash_mismatch',
  unknown_hash_version: 'dashboard.audit.reason_unknown_hash_version',
};

export function Audit() {
  const [started, setStarted] = useState(false);
  return (
    <section class="screen" aria-labelledby="audit-title">
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.audit.eyebrow')}</p>
          <h1 id="audit-title">{t('dashboard.audit.title')}</h1>
        </div>
      </div>
      <p class="lede">{t('dashboard.audit.lede')}</p>
      {started ? (
        <AuditResult />
      ) : (
        <button type="button" class="button button-primary" onClick={() => setStarted(true)}>
          {t('dashboard.audit.run')}
        </button>
      )}
    </section>
  );
}

function AuditResult() {
  const { result, reload } = useApi((signal) => readAuditCheck({ signal }), []);
  return (
    <Show loaded={result}>
      {(chain, at) => (
        <div class={`verdict ${chain.ok ? 'verdict-ok' : 'verdict-broken'}`} role="status">
          <p class="verdict-mark" aria-hidden="true">
            {chain.ok ? '✓' : '!'}
          </p>
          <div>
            <h2>{chain.ok ? t('dashboard.audit.ok') : t('dashboard.audit.broken')}</h2>
            <p>
              {t('dashboard.audit.checked', { count: chain.checked, last_seq: chain.last_seq })}
            </p>
            {chain.broken && (
              <p>
                {t('dashboard.audit.broken_at', {
                  seq: chain.broken.seq,
                  reason: t(REASON_KEYS[chain.broken.reason] ?? chain.broken.reason),
                })}
              </p>
            )}
            <p class="asof">
              {t('dashboard.as_of')}{' '}
              <time dateTime={at.toISOString()}>{at.toLocaleTimeString()}</time>
            </p>
            <button type="button" class="button button-quiet" onClick={reload}>
              {t('dashboard.audit.run_again')}
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}
