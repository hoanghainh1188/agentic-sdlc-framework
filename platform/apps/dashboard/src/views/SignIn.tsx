// Sign-in with a personal API token (ADR-M54 §2.3): checked with GET /v1/me, then kept in memory
// only. The field is cleared at once; the token is never put in the URL or in storage.
import type { Me } from '@sdlc/api-schemas';
import { useRef, useState } from 'preact/hooks';

import { ApiError } from '../api/client.js';
import { readMe } from '../api/reads.js';
import { ErrorMessage } from '../components/common.js';
import { t } from '../i18n.js';
import { session, TOKEN_FORMAT } from '../session.js';

export function SignIn({ onSignedIn }: { readonly onSignedIn: (me: Me) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [formatError, setFormatError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    const field = input.current;
    if (!field) return;
    const token = field.value.trim();
    field.value = '';
    setError(null);
    setFormatError(false);
    if (!TOKEN_FORMAT.test(token)) {
      setFormatError(true);
      field.focus();
      return;
    }
    setBusy(true);
    try {
      const me = await readMe(token);
      session.signIn(token);
      onSignedIn(me);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'unexpected'));
      field.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" class="signin">
      <section class="signin-panel" aria-labelledby="signin-title">
        <p class="eyebrow">{t('dashboard.brand')}</p>
        <h1 id="signin-title">{t('dashboard.signin.title')}</h1>
        <p class="lede">{t('dashboard.signin.lede')}</p>
        <form onSubmit={(event) => void submit(event)} noValidate>
          <label for="token">{t('dashboard.signin.token_label')}</label>
          <input
            ref={input}
            id="token"
            type="password"
            // A one-time code is never saved by password managers: the token stays in memory.
            autocomplete="one-time-code"
            spellcheck={false}
            aria-describedby="token-help"
            aria-invalid={formatError || error !== null}
            disabled={busy}
          />
          <p id="token-help" class="hint">
            {t('dashboard.signin.token_help')}
          </p>
          {formatError && (
            <p class="notice notice-error" role="alert">
              {t('dashboard.signin.token_format')}
            </p>
          )}
          {error && <ErrorMessage error={error} />}
          <button type="submit" class="button button-primary" disabled={busy}>
            {busy ? t('dashboard.signin.checking') : t('dashboard.signin.submit')}
          </button>
        </form>
        <ul class="signin-facts">
          <li>{t('dashboard.signin.fact_read_only')}</li>
          <li>{t('dashboard.signin.fact_memory')}</li>
        </ul>
      </section>
    </main>
  );
}
