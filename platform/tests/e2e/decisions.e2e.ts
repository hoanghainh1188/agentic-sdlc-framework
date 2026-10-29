// U07 in a real browser (design/ADR-M73 §2.4b, §2.6; QUESTIONS #377, #378): a person with a
// GitHub session and actions on approves a gate, kills a run, and acknowledges and decides an
// escalation. Each decision is confirmed with Chromium's virtual passkey; the stub checks the
// step-up with the api's own WebAuthn code, the request SHA-256 with core's function and the
// bound input hash. The refusals of N5 (the producer, a wrong role, the same person twice) and a
// changed gate input are shown in the catalog's words; G7 is a link to the pull request only.
// A person signed in with a token sees no action. Screens at 375, 768 and 1440 px, light and
// dark, without horizontal scroll. Chromium only: the virtual authenticator is a Chromium feature.
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const PORT = Number(process.env.SDLC_DASHBOARD_E2E_PORT);
const LOCAL = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'screenshots');

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'the virtual authenticator is Chromium’s',
);

async function virtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** Whether this test added a passkey to the stub's one demo person (removed after the test). */
let added = false;

/** GitHub sign-in, then a passkey added on the passkeys screen. */
async function signedIn(page: Page): Promise<void> {
  await virtualAuthenticator(page);
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Tenant').fill('demo');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  await page.goto(`${LOCAL}/dashboard/#/passkeys`);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('status')).toHaveText('Passkey added.');
  added = true;
}

// The stub keeps the passkeys of the whole run; each test leaves the list as it found it, so the
// later screens' step-ups (L05) do not see a long list of passkeys from other tests.
test.afterEach(async ({ page }) => {
  if (!added) return;
  added = false;
  page.removeAllListeners('dialog');
  await page.goto(`${LOCAL}/dashboard/#/passkeys`);
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await page.getByRole('button', { name: 'Remove this passkey' }).click();
  await expect(page.getByRole('status')).toHaveText('Passkey removed.');
});

function watchWrites(page: Page): { writes: string[]; csrf: (string | undefined)[] } {
  const w = { writes: [] as string[], csrf: [] as (string | undefined)[] };
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (req.method() !== 'GET' && url.pathname.startsWith('/v1/')) {
      w.writes.push(`${req.method()} ${url.pathname.replace(/[0-9a-f-]{36}/, ':id')}`);
      w.csrf.push(req.headers()['x-sdlc-csrf']);
    }
  });
  return w;
}

/** Opens an intent, asks to approve its gate and confirms with the passkey. */
async function approve(page: Page, code: string): Promise<void> {
  await page.goto(`${LOCAL}/dashboard/#/intents/${code}`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /^Approve G[1-8]/ })).toBeVisible();
  await expect(dialog.getByText('aaaaaaaaaaaaaaaa…')).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm with passkey' }).click();
}

test('U07: approve G1 with a passkey; the same person twice is refused', async ({ page }) => {
  await signedIn(page);
  const w = watchWrites(page);
  await approve(page, 'INT-2026-0001');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(w.writes).toEqual([
    'POST /v1/auth/step-up',
    'POST /v1/intents/INT-2026-0001/gates/G1/decisions',
  ]);
  for (const csrf of w.csrf) expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);

  await approve(page, 'INT-2026-0001');
  await expect(
    page
      .getByRole('dialog')
      .getByText('You already approved this: dual approval needs two different people.'),
  ).toBeVisible();
});

test('U07 (N5): the producer and a wrong role are refused in the catalog’s words', async ({
  page,
}) => {
  await signedIn(page);
  await approve(page, 'INT-2026-0002');
  await expect(
    page
      .getByRole('dialog')
      .getByText('You produced this change, so you cannot approve it (separation of duties).'),
  ).toBeVisible();
  await approve(page, 'INT-2026-0003');
  await expect(
    page.getByRole('dialog').getByText('You do not hold a role that may decide this gate.'),
  ).toBeVisible();
});

test('U07: a gate input that changed since the page read it is a conflict', async ({ page }) => {
  await signedIn(page);
  await approve(page, 'INT-2026-0004');
  await expect(
    page.getByRole('dialog').getByText(/The input to this gate changed while you were reviewing/),
  ).toBeVisible();
});

test('U07: G7 is a link to the pull request, with no approve button', async ({ page }) => {
  await signedIn(page);
  await page.goto(`${LOCAL}/dashboard/#/intents/INT-2026-0006`);
  const decided = page.getByRole('region', { name: 'Who decides this gate' });
  await expect(decided.getByRole('link', { name: /Open Pull Request/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request changes' })).toHaveCount(0);
});

test('U07: kill a run after the confirmation; no passkey', async ({ page }) => {
  await signedIn(page);
  const w = watchWrites(page);
  const asked: string[] = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    void d.accept();
  });
  await page.goto(`${LOCAL}/dashboard/#/intents/INT-2026-0003`);
  await page.getByRole('button', { name: 'Kill run' }).click();
  await expect.poll(() => w.writes).toEqual(['POST /v1/runs/:id/kill']);
  expect(asked).toEqual(['Are you sure you want to kill this run?']);
});

test('U07: acknowledge an escalation; decide one with a passkey bound to its packet', async ({
  page,
}) => {
  await signedIn(page);
  const w = watchWrites(page);
  await page.goto(`${LOCAL}/dashboard/#/escalations`);
  const open = page.getByRole('row', { name: /ESC-2026-0004/ });
  await open.getByRole('button', { name: 'Acknowledge' }).click();
  await expect.poll(() => w.writes).toEqual(['POST /v1/escalations/ESC-2026-0004/ack']);

  const acked = page.getByRole('row', { name: /ESC-2026-0005/ });
  await expect(acked.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
  await acked.getByRole('button', { name: 'Decide' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Decision').selectOption('resume');
  await dialog.getByRole('button', { name: 'Confirm with passkey' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(w.writes).toEqual([
    'POST /v1/escalations/ESC-2026-0004/ack',
    'POST /v1/auth/step-up',
    'POST /v1/escalations/ESC-2026-0005/decisions',
  ]);
});

test('U07: signed in with a token: no decision, kill or acknowledgement', async ({ page }) => {
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Personal API token').fill(process.env.SDLC_DASHBOARD_E2E_TOKEN!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  await page.goto(`${LOCAL}/dashboard/#/intents/INT-2026-0003`);
  await expect(page.getByRole('heading', { name: 'Who decides this gate' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Kill run' })).toHaveCount(0);
  await page.goto(`${LOCAL}/dashboard/#/escalations`);
  await expect(page.getByRole('row', { name: /ESC-2026-0004/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
});

for (const width of [375, 768, 1440]) {
  test(`U07: the decision screens at ${width} px, light and dark; no horizontal scroll`, async ({
    page,
  }) => {
    await signedIn(page);
    const screens = [
      ['decision', '#/intents/INT-2026-0001', 'Approve'],
      ['escalation', '#/escalations', 'Decide'],
    ] as const;
    for (const [name, route, button] of screens) {
      await page.goto(`${LOCAL}/dashboard/${route}`);
      await page.getByRole('button', { name: button, exact: true }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      for (const scheme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${name} ${scheme}`).toBeLessThanOrEqual(0);
        await page.screenshot({
          path: path.join(SHOTS, `${width}-${scheme}-u07-${name}.png`),
          fullPage: true,
        });
      }
    }
  });
}
