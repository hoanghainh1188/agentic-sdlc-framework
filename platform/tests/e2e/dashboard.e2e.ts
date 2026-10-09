// U01 AC1–AC6 in a real browser (design/ADR-M54): sign-in with a personal token, every screen,
// read only (GET only), no CSP violation, the token never stored, keyboard use, no horizontal
// scroll, and screenshots at 375, 768 and 1440 px in light and dark.
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const TOKEN = process.env.SDLC_DASHBOARD_E2E_TOKEN!;
const SHOTS = path.join(__dirname, 'screenshots');

interface Watch {
  readonly methods: string[];
  readonly problems: string[];
  readonly urls: string[];
}

function watch(page: Page): Watch {
  const w: Watch = { methods: [], problems: [], urls: [] };
  page.on('request', (req) => {
    w.urls.push(req.url());
    if (new URL(req.url()).pathname.startsWith('/v1/')) w.methods.push(req.method());
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' || /Content Security Policy/i.test(msg.text())) {
      w.problems.push(msg.text());
    }
  });
  page.on('pageerror', (err) => w.problems.push(err.message));
  return w;
}

async function signIn(page: Page, token = TOKEN): Promise<void> {
  await page.goto('/dashboard/');
  await page.getByLabel('Personal API token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('sign-in refuses a malformed and an unknown token', async ({ page }) => {
  const w = watch(page);
  await page.goto('/dashboard/');
  await expect(page.getByRole('heading', { name: 'Sign in with your API token' })).toBeVisible();
  await page.getByLabel('Personal API token').fill('not-a-token');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('It starts with sdlc_pat_');
  // The right format, another value: the API answers 401.
  await signIn(page, `sdlc_pat_${'A'.repeat(43)}`);
  await expect(page.getByRole('alert')).toContainText('not valid any more');
  await expect(page.getByLabel('Personal API token')).toHaveValue('');
  // Failed console lines from the 401 are expected; no CSP or script error.
  expect(w.problems.filter((p) => !/401/.test(p))).toEqual([]);
});

test('every screen, read only, the token in memory only (AC1, AC2, AC3, AC4)', async ({ page }) => {
  const w = watch(page);
  await signIn(page);

  // The board: lanes by gate, cards, flags.
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'INT-2026-0006' })).toBeVisible();
  await expect(page.getByText('past deadline').first()).toBeVisible();
  await expect(page.getByText('frozen').first()).toBeVisible();
  // Finished intents stay off the open board.
  await expect(page.getByRole('link', { name: 'INT-2026-0011' })).toHaveCount(0);
  // U02: a recorded hold shows on its card, with the failed check.
  const held = page.locator('article', { has: page.getByRole('link', { name: 'INT-2026-0004' }) });
  await expect(held).toContainText('A G4 check failed: the agent is not active');
  // `decision` is the normal wait, not a hold.
  const plain = page.locator('article', { has: page.getByRole('link', { name: 'INT-2026-0001' }) });
  await expect(plain.locator('.card-hold')).toHaveCount(0);

  // An intent: who decides its gate, decisions, runs, packs.
  // U02: an intent held by a failed G4 check: "What holds it" names the check.
  await page.getByRole('link', { name: 'INT-2026-0004' }).click();
  await expect(page.getByRole('heading', { name: 'What holds it' })).toBeVisible();
  await expect(page.getByText('A G4 check failed: the agent is not active')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();

  await page.getByRole('link', { name: 'INT-2026-0006' }).click();
  await expect(page.getByRole('heading', { name: 'Who decides this gate' })).toBeVisible();
  await expect(
    page.getByText('Approvers: Person B, Second approver. Approvals needed: 2.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'PR #38' }).first()).toHaveAttribute(
    'href',
    'https://github.com/harryforge/pilot-order-inventory/pull/38',
  );
  await expect(page.getByRole('heading', { name: 'Evidence Packs' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Markdown' }).click();
  expect((await download).suggestedFilename()).toBe('INT-2026-0006-v1-pack.md');

  // Escalations, the nearest deadline first.
  await page.getByRole('link', { name: 'Escalations' }).click();
  const rows = page.locator('table.esc-table tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('ESC-2026-0004');
  await expect(rows.first()).toContainText('overdue');

  // Numbers: gate waiting times and cost.
  await page.getByRole('link', { name: 'Cost and gate times' }).click();
  await expect(
    page.getByRole('heading', { name: 'Gate waiting times (first round)' }),
  ).toBeVisible();
  await expect(page.getByText('$7.01')).toBeVisible();
  await page.getByRole('button', { name: 'Model', exact: true }).click();
  await expect(page.getByRole('rowheader', { name: 'gpt-oss-20b' })).toBeVisible();
  expect(page.url()).toContain('by=model');

  // The audit check (tenant admin).
  await page.getByRole('link', { name: 'Audit check' }).click();
  await page.getByRole('button', { name: 'Run the check' }).click();
  await expect(page.getByRole('heading', { name: 'The audit chain is intact' })).toBeVisible();

  // Read only: every API call was a GET; nothing left the origin; no CSP or script error.
  expect(new Set(w.methods)).toEqual(new Set(['GET']));
  const origin = new URL(page.url()).origin;
  expect(w.urls.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:'))).toEqual([]);
  expect(w.problems).toEqual([]);

  // The token: never in the URL, storage or cookies.
  expect(page.url()).not.toContain(TOKEN);
  const stored = await page.evaluate(() => ({
    local: window.localStorage.length,
    session: window.sessionStorage.length,
    cookie: document.cookie,
  }));
  expect(stored).toEqual({ local: 0, session: 0, cookie: '' });

  // Sign out forgets it; a reload asks again.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in with your API token' })).toBeVisible();
  await page.goto('/dashboard/#/escalations');
  await expect(page.getByRole('heading', { name: 'Sign in with your API token' })).toBeVisible();
});

test('the CSP blocks inline script (AC3)', async ({ page }) => {
  const response = await page.goto('/dashboard/');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  const ran = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inline = 1';
    document.body.append(s);
    return (window as unknown as { __inline?: number }).__inline ?? 0;
  });
  expect(ran).toBe(0);
});

test('keyboard: sign in, skip link, navigation (AC5)', async ({ page }) => {
  await page.goto('/dashboard/');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Personal API token')).toBeFocused();
  await page.keyboard.type(TOKEN);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to the content' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Intents and gates' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Open escalations, the nearest deadline first' }),
  ).toBeVisible();
});

const SCREENS = [
  ['board', '#/intents', 'Where every intent waits'],
  ['intent', '#/intents/INT-2026-0006', 'Who decides this gate'],
  ['intent-held', '#/intents/INT-2026-0004', 'What holds it'],
  ['escalations', '#/escalations', 'Open escalations, the nearest deadline first'],
  ['numbers', '#/numbers?project=pilot&by=intent', 'Gate waiting times (first round)'],
] as const;

for (const width of [375, 768, 1440]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`screenshots at ${width} px, ${scheme}; no horizontal scroll (AC6)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await signIn(page);
      await page.screenshot({ path: path.join(SHOTS, `${width}-${scheme}-signin-done.png`) });
      for (const [name, hash, heading] of SCREENS) {
        await page.evaluate((h) => (window.location.hash = h), hash);
        await expect(page.getByRole('heading', { name: heading })).toBeVisible();
        // Each section loads on its own: wait until none says "Loading…".
        await expect(page.getByText('Loading…')).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${name} at ${width}`).toBeLessThanOrEqual(0);
        await page.screenshot({
          path: path.join(SHOTS, `${width}-${scheme}-${name}.png`),
          fullPage: true,
        });
      }
    });
  }
}

test('the sign-in page in light and dark', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard/');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(SHOTS, `1440-${scheme}-signin.png`) });
  }
});
