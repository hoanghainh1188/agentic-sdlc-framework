// L05 in a real browser (design/ADR-M82 §2.7; QUESTIONS #465, #470, #477, #478): a manager with a
// GitHub session and actions on reads the evaluation plans of a project, asks for a run now
// (confirmed with Chromium's virtual passkey), creates a plan, changes it, and follows an
// evaluation. Every write carries the session's CSRF token; the stub checks the passkey with the
// api's own WebAuthn code and the step-up's request SHA-256 with core's function. A person signed
// in with a token sees the plans and no action. Screens at 320, 768, 1024 and 1440 px, light and
// dark, without horizontal scroll. Chromium only: the virtual authenticator is a Chromium feature.
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const PORT = Number(process.env.SDLC_DASHBOARD_E2E_PORT);
const LOCAL = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'screenshots');
const PLAN = '11111111-1111-4111-8111-111111111111';

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

/** GitHub sign-in, then a passkey added on the passkeys screen. */
async function manager(page: Page): Promise<void> {
  await virtualAuthenticator(page);
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Tenant').fill('demo');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  await page.goto(`${LOCAL}/dashboard/#/passkeys`);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('status')).toHaveText('Passkey added.');
}

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

test('L05: the plans of a project; Run now is confirmed with a passkey', async ({ page }) => {
  await manager(page);
  const w = watchWrites(page);
  await page.getByRole('link', { name: 'Evaluations' }).click();
  await page.getByLabel('Project').selectOption('shop');
  await expect(page.getByRole('heading', { name: 'Evaluation plans' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'weekly-models' })).toBeVisible();
  // The worker's last refusal, in the catalog's words.
  await expect(page.getByText('A model of the configurations is not allowed')).toBeVisible();
  await page.getByRole('link', { name: 'weekly-models' }).click();
  await expect(page.getByRole('heading', { name: 'weekly-models' })).toBeVisible();
  await expect(page.getByText('Every Monday at 6:00 UTC')).toBeVisible();
  await expect(page.getByText('prompt file eval/prompts/short.md')).toBeVisible();

  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Run requested. The worker starts it within a minute.',
  );
  await expect(page.getByRole('button', { name: 'Run now' })).toBeDisabled();
  expect(w.writes).toEqual(['POST /v1/auth/step-up', 'POST /v1/eval-plans/:id/runs']);
  for (const csrf of w.csrf) expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);

  await page.getByRole('link', { name: 'EVAL-2026-0001' }).click();
  await expect(page.getByRole('heading', { name: 'EVAL-2026-0001' })).toBeVisible();
  await expect(page.getByText('2.75 USD of 6.000000 USD')).toBeVisible();
});

test('L05: create a plan that runs once (no passkey), then raise its budget (passkey)', async ({
  page,
}) => {
  await manager(page);
  const w = watchWrites(page);
  await page.goto(`${LOCAL}/dashboard/#/evaluations?project=shop`);
  await page.getByRole('link', { name: 'New plan' }).click();
  await expect(page.getByRole('heading', { name: 'New evaluation plan' })).toBeVisible();
  // A wrong field is named before anything is sent.
  await page.getByRole('button', { name: 'Create the plan' }).click();
  await expect(page.getByRole('alert')).toHaveText(/The name must be lowercase/);
  await page.getByLabel('Name (a code)').fill('nightly-small');
  await page.getByLabel('Agent key').fill('openhands-qwen');
  await page.getByLabel('Prompt file (optional)').fill('eval/prompts/short.md');
  await page.getByRole('button', { name: 'Create the plan' }).click();
  await expect(page.getByRole('heading', { name: 'nightly-small' })).toBeVisible();
  expect(w.writes).toEqual(['POST /v1/projects/shop/eval-plans']);

  await page.getByRole('link', { name: 'Change' }).click();
  await expect(page.getByRole('heading', { name: 'Change the evaluation plan' })).toBeVisible();
  await page.getByLabel('Budget per run (USD)').fill('2');
  await page.getByRole('button', { name: 'Save as a new version' }).click();
  await expect(page.getByRole('heading', { name: 'nightly-small' })).toBeVisible();
  await expect(page.getByText('version 2')).toBeVisible();
  expect(w.writes).toEqual([
    'POST /v1/projects/shop/eval-plans',
    'POST /v1/auth/step-up',
    'POST /v1/eval-plans/:id/versions',
  ]);
});

test('L05: signed in with a token: the plans, and no action', async ({ page }) => {
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Personal API token').fill(process.env.SDLC_DASHBOARD_E2E_TOKEN!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  await page.goto(`${LOCAL}/dashboard/#/evaluations?project=shop`);
  await expect(page.getByRole('link', { name: 'weekly-models' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New plan' })).toHaveCount(0);
  await page.goto(`${LOCAL}/dashboard/#/evaluations/plans/${PLAN}`);
  await expect(page.getByRole('heading', { name: 'weekly-models' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run now' })).toHaveCount(0);
});

const SCREENS = [
  ['list', '#/evaluations?project=shop', 'Evaluation plans'],
  ['plan', `#/evaluations/plans/${PLAN}`, 'weekly-models'],
  ['form', '#/evaluations/plans/new?project=shop', 'New evaluation plan'],
  ['evaluation', '#/evaluations/EVAL-2026-0001', 'EVAL-2026-0001'],
] as const;

for (const width of [320, 768, 1024, 1440]) {
  test(`L05: the evaluation screens at ${width} px, light and dark; no horizontal scroll`, async ({
    page,
  }) => {
    await manager(page);
    for (const [name, route, heading] of SCREENS) {
      await page.goto(`${LOCAL}/dashboard/${route}`);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      for (const scheme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${name} ${scheme}`).toBeLessThanOrEqual(0);
        await page.screenshot({
          path: path.join(SHOTS, `${width}-${scheme}-eval-${name}.png`),
          fullPage: true,
        });
      }
    }
  });
}
