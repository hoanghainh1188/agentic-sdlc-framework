// The person's own passkeys (task U06, design/ADR-M73 §2.4): list, add, remove. Shown only for a
// GitHub sign-in when the platform has actions on. A passkey confirms each decision made in the
// dashboard (U07); it is added within 5 minutes of a GitHub sign-in. The WebAuthn ceremony runs
// in the browser (`@simplewebauthn/browser`); the API checks the answer.
import type { PasskeyView } from '@sdlc/api-schemas';
import { startRegistration } from '@simplewebauthn/browser';
import { useState } from 'preact/hooks';

import { ApiError } from '../api/client.js';
import { readPasskeys } from '../api/reads.js';
import { useApi } from '../api/use-api.js';
import { passkeyRegistrationOptions, registerPasskey, removePasskey } from '../api/writes.js';
import { Empty, Show, Txt, When } from '../components/common.js';
import { t } from '../i18n.js';

type Notice =
  { readonly kind: 'ok'; readonly key: string } | { readonly kind: 'error'; readonly key: string };

/** The message of a refused or failed passkey request, by the API's code. */
export function passkeyErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'recent_signin_required') return 'dashboard.passkeys.error.recent_signin';
    if (error.code === 'too_many_passkeys') return 'dashboard.passkeys.error.too_many';
    if (error.code === 'challenge_refused') return 'dashboard.passkeys.error.expired';
    if (error.code === 'dashboard_actions_off') return 'dashboard.passkeys.error.actions_off';
    if (error.status === 401) return 'dashboard.error.unauthorized';
    return 'dashboard.passkeys.error.failed';
  }
  // The browser's ceremony: cancelled, timed out, or no authenticator.
  return 'dashboard.passkeys.error.cancelled';
}

export function Passkeys() {
  const { result, reload } = useApi((signal) => readPasskeys({ signal }), []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const { challenge_id: challengeId, options } = await passkeyRegistrationOptions();
      let response: unknown;
      try {
        response = await startRegistration({ optionsJSON: options });
      } catch {
        setNotice({ kind: 'error', key: 'dashboard.passkeys.error.cancelled' });
        return;
      }
      await registerPasskey(challengeId, response);
      setNotice({ kind: 'ok', key: 'dashboard.passkeys.added' });
      reload();
    } catch (error) {
      setNotice({ kind: 'error', key: passkeyErrorKey(error) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await removePasskey(id);
      setConfirming(null);
      setNotice({ kind: 'ok', key: 'dashboard.passkeys.removed' });
      reload();
    } catch (error) {
      setNotice({ kind: 'error', key: passkeyErrorKey(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="screen" aria-labelledby="passkeys-title">
      <div class="screen-head">
        <div>
          <p class="eyebrow">{t('dashboard.passkeys.eyebrow')}</p>
          <h1 id="passkeys-title">{t('dashboard.passkeys.title')}</h1>
        </div>
        <div class="toolbar">
          <button
            type="button"
            class="button button-primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => void add()}
          >
            {t('dashboard.passkeys.add')}
          </button>
        </div>
      </div>
      <p class="hint">{t('dashboard.passkeys.intro')}</p>
      {notice && (
        <p
          class={notice.kind === 'error' ? 'notice notice-error' : 'notice'}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {t(notice.key)}
        </p>
      )}
      <Show loaded={result}>
        {({ items }) => {
          const active = items.filter((item) => item.revoked_at === null);
          if (active.length === 0) return <Empty messageKey="dashboard.passkeys.empty" />;
          return (
            <div class="table-wrap">
              <table class="passkey-table">
                <caption class="visually-hidden">{t('dashboard.passkeys.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('dashboard.passkeys.col.added')}</th>
                    <th scope="col">{t('dashboard.passkeys.col.last_used')}</th>
                    <th scope="col">{t('dashboard.passkeys.col.model')}</th>
                    <th scope="col">
                      <span class="visually-hidden">{t('dashboard.passkeys.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((item) => (
                    <PasskeyRow
                      key={item.id}
                      item={item}
                      busy={busy}
                      confirming={confirming === item.id}
                      onAsk={() => setConfirming(item.id)}
                      onCancel={() => setConfirming(null)}
                      onRemove={() => void remove(item.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Show>
    </section>
  );
}

function PasskeyRow({
  item,
  busy,
  confirming,
  onAsk,
  onCancel,
  onRemove,
}: {
  readonly item: PasskeyView;
  readonly busy: boolean;
  readonly confirming: boolean;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <tr>
      <td>
        <When iso={item.created_at} />
      </td>
      <td>
        {item.last_used_at === null ? (
          <span class="muted">{t('dashboard.passkeys.never_used')}</span>
        ) : (
          <When iso={item.last_used_at} />
        )}
      </td>
      <td class="passkey-model">
        {item.aaguid === null ? (
          <span class="muted">{t('dashboard.passkeys.model_unknown')}</span>
        ) : (
          <Txt value={item.aaguid} />
        )}
      </td>
      <td class="row-actions-cell">
        <div class="row-actions">
          {confirming ? (
            <>
              <button type="button" class="button button-danger" disabled={busy} onClick={onRemove}>
                {t('dashboard.passkeys.remove_confirm')}
              </button>
              <button type="button" class="button button-quiet" disabled={busy} onClick={onCancel}>
                {t('dashboard.passkeys.remove_cancel')}
              </button>
            </>
          ) : (
            <button type="button" class="button button-quiet" disabled={busy} onClick={onAsk}>
              {t('dashboard.passkeys.remove')}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
