// U05 in a real browser (design/ADR-M73 §2.2): sign-in with GitHub on `http://localhost`, the
// session cookie's attributes, a reload keeps the session, sign out and sign out everywhere end
// it, a refusal shows one message and leaves the address bar clean, and the page stays read only
// (its only writes are the two sign-out calls). The stub API plays GitHub (stub-api.mjs); on
// 127.0.0.1 GitHub sign-in is off, so the other tests see the token page they always saw.
// Chromium by default; Firefox and WebKit run the same file when their browsers are installed.
// WebKit keeps no `Secure` cookie on `http://localhost` (2026-10-12, Playwright WebKit 26.6): the
// known limit of ADR-M73 §4. The cookie tests are skipped there and one test pins the limit, so a
// WebKit that starts keeping the cookie is noticed. The cookie rules are never weakened for it.
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const PORT = Number(process.env.SDLC_DASHBOARD_E2E_PORT);
const LOCAL = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'screenshots');

function watchApi(page: Page): { calls: string[]; problems: string[]; origins: string[] } {
  const w = { calls: [] as string[], problems: [] as string[], origins: [] as string[] };
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/v1/')) w.calls.push(`${req.method()} ${url.pathname}`);
  });
  // The stub answers a write with another Origin (or `Origin: null`) with 403, like the API.
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (res.request().method() !== 'GET' && url.pathname.startsWith('/v1/')) {
      w.origins.push(`${res.request().method()} ${url.pathname} ${res.status()}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /Content Security Policy/i.test(msg.text())) {
      w.problems.push(msg.text());
    }
  });
  page.on('pageerror', (err) => w.problems.push(err.message));
  return w;
}

async function signInWithGitHub(page: Page, tenant = 'demo'): Promise<void> {
  await page.goto(`${LOCAL}/dashboard/`);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Tenant').fill(tenant);
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
}

const WEBKIT_LIMIT = 'WebKit keeps no Secure cookie on http://localhost (ADR-M73 §4)';

test('U05: WebKit on http://localhost: no Secure cookie, so the sign-in is refused (known limit)', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'the limit is WebKit’s');
  await signInWithGitHub(page);
  await expect(page.getByRole('alert')).toContainText('Sign-in with GitHub was refused');
  expect((await context.cookies(LOCAL)).map((c) => c.name)).toEqual([]);
});

test('U05: sign in with GitHub, the session cookie, reload, sign out', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName === 'webkit', WEBKIT_LIMIT);
  const w = watchApi(page);
  await signInWithGitHub(page);
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();

  const cookies = await context.cookies(LOCAL);
  const session = cookies.find((c) => c.name === '__Host-sdlc_session');
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
  expect(cookies.find((c) => c.name === '__Host-sdlc_oauth')).toBeUndefined();
  // The page never sees the cookie.
  expect(await page.evaluate(() => document.cookie)).toBe('');

  // A reload keeps the session (the API answers GET /v1/me with the cookie).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  expect(
    (await context.cookies(LOCAL)).find((c) => c.name === '__Host-sdlc_session'),
  ).toBeUndefined();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();

  // The sign-out carried the dashboard's own origin (the API refuses `Origin: null`): 204.
  expect(w.origins).toEqual(['POST /v1/auth/sign-out 204']);
  // Read only: the only writes are the sign-out call; no Authorization header was needed.
  const writes = w.calls.filter((c) => !c.startsWith('GET '));
  expect(writes).toEqual(['POST /v1/auth/sign-out']);
  // The 401 of the check at start (no session yet, or after sign-out) is expected.
  expect(w.problems.filter((p) => !/401/.test(p))).toEqual([]);
});

test('U05: sign out everywhere ends every session of the person', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName === 'webkit', WEBKIT_LIMIT);
  const one = await browser.newContext();
  const two = await browser.newContext();
  try {
    const a = await one.newPage();
    const b = await two.newPage();
    await signInWithGitHub(a);
    await signInWithGitHub(b);
    await expect(b.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
    await a.getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(a.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    // The other browser's next read finds its session ended and goes back to sign-in.
    await b.reload();
    await expect(b.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  } finally {
    await one.close();
    await two.close();
  }
});

test('U05: a refused sign-in shows one message and leaves a clean address', async ({ page }) => {
  await signInWithGitHub(page, 'nosuch');
  await expect(page.getByRole('alert')).toContainText('Sign-in with GitHub was refused');
  expect(new URL(page.url()).search).toBe('');
  // A malformed tenant never leaves the page.
  await page.getByLabel('Tenant').fill('Not A Tenant');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'This is not a tenant name' }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/dashboard/');
});

test('U05: the personal token still works next to GitHub', async ({ page }) => {
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Personal API token').fill(process.env.SDLC_DASHBOARD_E2E_TOKEN!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  // A token sign-in has no "Sign out everywhere" (that ends GitHub sessions).
  await expect(page.getByRole('button', { name: 'Sign out everywhere' })).toHaveCount(0);
});

for (const width of [375, 1440]) {
  test(`U05: the sign-in page with GitHub at ${width} px, light and dark`, async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto(`${LOCAL}/dashboard/`);
      await expect(page.getByLabel('Tenant')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: path.join(SHOTS, `${width}-${scheme}-signin-github.png`) });
    }
  });
}
