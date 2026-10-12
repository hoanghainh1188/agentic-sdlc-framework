// Sign-in with a personal API token (ADR-M54 §2.3): checked with GET /v1/me, then kept in memory
// only. The field is cleared at once; the token is never put in the URL or in storage.
// U05 (ADR-M73 §2.2): when the API has GitHub sign-in on, the person may sign in with GitHub
// instead: the tenant's slug, then a top-level navigation to the API, which redirects to GitHub
// and back. The session lives in an `HttpOnly` cookie this code never sees.
import type { Me } from '@sdlc/api-schemas';
import { useRef, useState } from 'preact/hooks';

import { ApiError } from '../api/client.js';
import { gitHubSignInUrl, readMe, TENANT_SLUG } from '../api/reads.js';
import { ErrorMessage } from '../components/common.js';
import { t } from '../i18n.js';
import { session, TOKEN_FORMAT } from '../session.js';

/** What the API's GitHub callback said when it sent the browser back (`?signin=…`). */
export type SignInNotice = 'refused' | 'unavailable';

export interface SignInProps {
  readonly onSignedIn: (me: Me) => void;
  /** GitHub sign-in is on (`GET /v1/auth/config`). */
  readonly github: boolean;
  readonly notice: SignInNotice | null;
}

export function SignIn({ onSignedIn, github, notice }: SignInProps) {
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

  const tokenForm = (
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
  );

  return (
    <main id="main" class="signin">
      <section class="signin-panel" aria-labelledby="signin-title">
        <p class="eyebrow">{t('dashboard.brand')}</p>
        <h1 id="signin-title">
          {github ? t('dashboard.signin.title_any') : t('dashboard.signin.title')}
        </h1>
        <p class="lede">{t('dashboard.signin.lede')}</p>
        {notice && (
          <p class="notice notice-error" role="alert">
            {notice === 'refused'
              ? t('dashboard.signin.github_refused')
              : t('dashboard.signin.github_unavailable')}
          </p>
        )}
        {github ? (
          <>
            <GitHubSignIn />
            <section class="signin-alt" aria-labelledby="signin-token-title">
              <h2 id="signin-token-title">{t('dashboard.signin.title')}</h2>
              {tokenForm}
            </section>
          </>
        ) : (
          tokenForm
        )}
        <ul class="signin-facts">
          <li>{t('dashboard.signin.fact_read_only')}</li>
          <li>{t('dashboard.signin.fact_memory')}</li>
          {github && <li>{t('dashboard.signin.fact_github')}</li>}
        </ul>
      </section>
    </main>
  );
}

/** The tenant's slug, then the browser goes to the API, which sends it on to GitHub (U05). */
function GitHubSignIn() {
  const field = useRef<HTMLInputElement>(null);
  const [invalid, setInvalid] = useState(false);

  const submit = (event: Event) => {
    event.preventDefault();
    const tenant = field.current?.value.trim() ?? '';
    if (!TENANT_SLUG.test(tenant)) {
      setInvalid(true);
      field.current?.focus();
      return;
    }
    window.location.assign(gitHubSignInUrl(tenant));
  };

  return (
    <form class="signin-github" onSubmit={submit} noValidate>
      <label for="tenant">{t('dashboard.signin.tenant_label')}</label>
      <input
        ref={field}
        id="tenant"
        type="text"
        autocomplete="off"
        autocapitalize="none"
        spellcheck={false}
        aria-describedby="tenant-help"
        aria-invalid={invalid}
      />
      <p id="tenant-help" class="hint">
        {t('dashboard.signin.tenant_help')}
      </p>
      {invalid && (
        <p class="notice notice-error" role="alert">
          {t('dashboard.signin.tenant_format')}
        </p>
      )}
      <button type="submit" class="button button-primary">
        {t('dashboard.signin.github_submit')}
      </button>
    </form>
  );
}
