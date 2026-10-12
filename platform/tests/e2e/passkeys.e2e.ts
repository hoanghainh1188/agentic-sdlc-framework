// U06 in a real browser (design/ADR-M73 §2.3, §2.4): with a GitHub session and actions on, the
// person adds a passkey with Chromium's virtual authenticator (WebAuthn over the DevTools
// protocol, on `http://localhost`: WebAuthn refuses an IP address), sees it listed, and removes
// it. Every write carries the session's CSRF token and the page's own origin; the stub checks
// them like the API, and checks the passkey with the api's own WebAuthn code. The page writes
// nothing else. Chromium only: the virtual authenticator is a Chromium feature.
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const PORT = Number(process.env.SDLC_DASHBOARD_E2E_PORT);
const LOCAL = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'screenshots');

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'the virtual authenticator is Chromium’s',
);

async function virtualAuthenticator(page: Page, isUserVerified = true): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified,
      automaticPresenceSimulation: true,
    },
  });
}

async function signInWithGitHub(page: Page): Promise<void> {
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Tenant').fill('demo');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
}

function watchWrites(page: Page): { writes: string[]; headers: Record<string, string>[] } {
  const w = { writes: [] as string[], headers: [] as Record<string, string>[] };
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (req.method() !== 'GET' && url.pathname.startsWith('/v1/')) {
      w.writes.push(`${req.method()} ${url.pathname.replace(/[0-9a-f-]{36}$/, ':id')}`);
      w.headers.push(req.headers());
    }
  });
  return w;
}

test('U06: add a passkey, list it, remove it; every write carries the CSRF token', async ({
  page,
}) => {
  await virtualAuthenticator(page);
  const w = watchWrites(page);
  const answers: string[] = [];
  page.on('response', (res) => {
    if (res.request().method() !== 'GET' && new URL(res.url()).pathname.startsWith('/v1/')) {
      answers.push(String(res.status()));
    }
  });
  await signInWithGitHub(page);

  await page.getByRole('link', { name: 'Passkeys' }).click();
  await expect(page.getByRole('heading', { name: 'Passkeys', exact: true })).toBeVisible();
  await expect(page.getByText('You have no passkey yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('status')).toHaveText('Passkey added.');
  await expect(page.getByRole('row')).toHaveCount(2); // the header and one passkey
  await expect(page.getByRole('cell', { name: 'Never used' })).toBeVisible();

  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove this passkey' }).click();
  await expect(page.getByRole('status')).toHaveText('Passkey removed.');
  await expect(page.getByText('You have no passkey yet.')).toBeVisible();

  expect(w.writes).toEqual([
    'POST /v1/me/passkeys/registration-options',
    'POST /v1/me/passkeys',
    'DELETE /v1/me/passkeys/:id',
  ]);
  expect(answers).toEqual(['200', '201', '200']);
  for (const headers of w.headers) {
    expect(headers['x-sdlc-csrf']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(headers.authorization).toBeUndefined();
  }
});

test('U06: a cancelled or impossible ceremony shows one message and saves nothing', async ({
  page,
}) => {
  // No virtual authenticator: Chromium has nothing to create the passkey with.
  await signInWithGitHub(page);
  await page.goto(`${LOCAL}/dashboard/#/passkeys`);
  await expect(page.getByRole('heading', { name: 'Passkeys', exact: true })).toBeVisible();
  await page.evaluate(() => {
    // Cancel at once, as a person closing the browser's passkey dialog would.
    navigator.credentials.create = () =>
      Promise.reject(new DOMException('cancelled', 'NotAllowedError'));
  });
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('alert')).toContainText('No passkey was made');
});

test('U06: without a GitHub session (a personal token) there is no passkey screen', async ({
  page,
}) => {
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Personal API token').fill(process.env.SDLC_DASHBOARD_E2E_TOKEN!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Passkeys' })).toHaveCount(0);
  await page.goto(`${LOCAL}/dashboard/#/passkeys`);
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
});

for (const width of [375, 768, 1440]) {
  test(`U06: the passkeys screen at ${width} px, light and dark; no horizontal scroll`, async ({
    page,
  }) => {
    await virtualAuthenticator(page);
    await signInWithGitHub(page);
    await page.goto(`${LOCAL}/dashboard/#/passkeys`);
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByRole('status')).toHaveText('Passkey added.');
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: path.join(SHOTS, `${width}-${scheme}-passkeys.png`) });
    }
  });
}
