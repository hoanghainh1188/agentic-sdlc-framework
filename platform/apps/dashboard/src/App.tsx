// The dashboard (task U01, design/ADR-M54): sign-in, then the screens of the route. Read only.
import type { Me } from '@sdlc/api-schemas';
import { useEffect, useState } from 'preact/hooks';

import { Txt } from './components/common.js';
import { t } from './i18n.js';
import { href, useRoute, type Route } from './router.js';
import { session } from './session.js';
import { Audit } from './views/Audit.js';
import { Escalations } from './views/Escalations.js';
import { IntentDetail } from './views/IntentDetail.js';
import { IntentsBoard } from './views/IntentsBoard.js';
import { Numbers } from './views/Numbers.js';
import { SignIn } from './views/SignIn.js';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const route = useRoute();

  // The API ended the session (401), or the person signed out: back to sign-in.
  useEffect(() => session.subscribe(() => session.token() === null && setMe(null)), []);
  useEffect(() => {
    document.title = me ? t('dashboard.title.signed_in') : t('dashboard.title.signed_out');
  }, [me]);

  if (me === null || session.token() === null) return <SignIn onSignedIn={setMe} />;
  return (
    <>
      <a class="skip" href="#main">
        {t('dashboard.nav.skip')}
      </a>
      <header class="masthead">
        <div class="masthead-inner">
          <a class="brand" href={href('intents')}>
            <span class="brand-mark" aria-hidden="true" />
            {t('dashboard.brand')}
          </a>
          <nav aria-label={t('dashboard.nav.label')}>
            <ul class="nav">
              <NavItem route={route} name="intents" label={t('dashboard.nav.intents')} />
              <NavItem route={route} name="escalations" label={t('dashboard.nav.escalations')} />
              <NavItem route={route} name="numbers" label={t('dashboard.nav.numbers')} />
              {me.tenant_admin === true && (
                <NavItem route={route} name="audit" label={t('dashboard.nav.audit')} />
              )}
            </ul>
          </nav>
          <div class="who">
            <span class="who-name">
              <Txt value={me.user.display_name} />
            </span>
            <span class="read-only-tag">{t('dashboard.read_only')}</span>
            <button type="button" class="button button-quiet" onClick={() => session.signOut()}>
              {t('dashboard.signout')}
            </button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Screen route={route} me={me} />
      </main>
    </>
  );
}

function NavItem({
  route,
  name,
  label,
}: {
  readonly route: Route;
  readonly name: Route['name'];
  readonly label: string;
}) {
  const active = route.name === name || (name === 'intents' && route.name === 'intent');
  return (
    <li>
      <a href={href(name)} aria-current={active ? 'page' : undefined}>
        {label}
      </a>
    </li>
  );
}

function Screen({ route, me }: { readonly route: Route; readonly me: Me }) {
  switch (route.name) {
    case 'intent':
      return <IntentDetail code={route.code} />;
    case 'escalations':
      return <Escalations />;
    case 'numbers':
      return <Numbers me={me} query={route.query} />;
    case 'audit':
      return me.tenant_admin === true ? <Audit /> : <IntentsBoard me={me} query={route.query} />;
    default:
      return <IntentsBoard me={me} query={route.query} />;
  }
}
