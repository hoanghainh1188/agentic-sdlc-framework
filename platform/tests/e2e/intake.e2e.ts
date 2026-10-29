// U08 in a real browser (design/ADR-M73 §2.1, MVP1-UI-SCOPE §3.3): a person with a GitHub session
// and actions on creates an intent and links its spec (the two calls of U03), submits a plan file
// and builds an Evidence Pack, with no passkey. The demo person is Person A in `shop` and Person B
// in `pilot`: the stub refuses as the API's default roles do, and the page shows each refusal in
// the catalog's words (no rule set of its own). A refused spec link keeps the intent and says so.
// The L1 proposal stays in the CLI: the page shows the command and never asks for the file. A
// person signed in with a token sees no action. Screens at 375, 768 and 1440 px, light and dark,
// without horizontal scroll. No test adds a passkey: none of these actions needs one.
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const PORT = Number(process.env.SDLC_DASHBOARD_E2E_PORT);
const LOCAL = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'screenshots');

async function signedIn(page: Page): Promise<void> {
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Tenant').fill('demo');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
}

interface Writes {
  readonly writes: string[];
  readonly bodies: unknown[];
  readonly csrf: (string | undefined)[];
}

function watchWrites(page: Page): Writes {
  const w: Writes = { writes: [], bodies: [], csrf: [] };
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (req.method() !== 'GET' && url.pathname.startsWith('/v1/')) {
      w.writes.push(`${req.method()} ${url.pathname}`);
      w.bodies.push(req.postDataJSON() as unknown);
      w.csrf.push(req.headers()['x-sdlc-csrf']);
    }
  });
  return w;
}

/** Opens the create form on the board and fills the title (and the spec path, when given). */
async function createForm(page: Page, project: string, specPath?: string) {
  await page.getByRole('button', { name: 'New intent' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Project').selectOption(project);
  await dialog.getByLabel('Title').fill('Export the order list as CSV');
  if (specPath !== undefined) {
    await dialog.getByLabel('Spec path in the repository (Markdown)').fill(specPath);
  }
  return dialog;
}

test('U08 AC1: Person A creates an intent and links its spec, with no passkey', async ({
  page,
}) => {
  await signedIn(page);
  const w = watchWrites(page);
  const dialog = await createForm(page, 'shop', 'docs/specs/T09.md');
  await dialog.getByRole('button', { name: 'Create intent' }).click();
  await expect(page).toHaveURL(/#\/intents\/INT-2026-0009$/);
  expect(w.writes).toEqual(['POST /v1/intents', 'POST /v1/intents/INT-2026-0009/specs']);
  expect(w.bodies[0]).toEqual({
    project: 'shop',
    title: 'Export the order list as CSV',
    description: '',
    risk_tier: 'low',
    data_class: 'internal',
  });
  expect(w.bodies[1]).toEqual({ path: 'docs/specs/T09.md', source_tool: 'manual' });
  for (const csrf of w.csrf) expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test('U08 AC1: a refused spec link keeps the intent and says why', async ({ page }) => {
  await signedIn(page);
  const w = watchWrites(page);
  const dialog = await createForm(page, 'shop', 'docs/specs/missing.md');
  await dialog.getByRole('button', { name: 'Create intent' }).click();
  await expect(
    dialog.getByRole('heading', { name: 'Intent created, spec not linked' }),
  ).toBeVisible();
  await expect(
    dialog.getByText('INT-2026-0009 was created. Its spec was not linked:'),
  ).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText(
    /^The spec cannot be read \(cause: missing\)\./,
  );
  await expect(dialog.getByText(/sdlc spec link INT-2026-0009 --path/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Open the intent' }).click();
  await expect(page).toHaveURL(/#\/intents\/INT-2026-0009$/);
  expect(w.writes).toEqual(['POST /v1/intents', 'POST /v1/intents/INT-2026-0009/specs']);
});

test('U08 AC3: Person B may not create an intent; a wrong field is checked before any call', async ({
  page,
}) => {
  await signedIn(page);
  const w = watchWrites(page);
  const dialog = await createForm(page, 'pilot');
  await dialog.getByLabel('Commit SHA (optional)').fill('abc');
  await dialog.getByRole('button', { name: 'Create intent' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'The spec commit must be a 40-character commit SHA, or empty.',
  );
  expect(w.writes).toEqual([]);

  await dialog.getByLabel('Commit SHA (optional)').fill('');
  await dialog.getByRole('button', { name: 'Create intent' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Your role in this project does not allow you to create an intent.',
  );
  expect(w.writes).toEqual(['POST /v1/intents']);
});

test('U08 AC2: Person A submits the plan; another commit and Person B are refused', async ({
  page,
}) => {
  await signedIn(page);
  const w = watchWrites(page);
  await page.goto(`${LOCAL}/dashboard/#/intents/INT-2026-0009`);
  const plan = page.getByRole('region', { name: 'Submit the plan' });
  await expect(plan.getByText('.sdlc/plans/INT-2026-0009.yaml')).toBeVisible();
  await plan.getByRole('button', { name: 'Submit plan' }).click();
  // The success stays above the data the page loads again.
  await expect(page.getByRole('status').filter({ hasText: 'Plan version' })).toHaveText(
    'Plan version 3 submitted.',
  );

  await plan.getByLabel('Commit SHA (optional)').fill('f'.repeat(40));
  await plan.getByRole('button', { name: 'Submit plan' }).click();
  await expect(plan.getByRole('alert')).toHaveText(
    /^The plan file at this commit differs from the file at the head of the default branch\./,
  );
  expect(w.bodies).toEqual([{}, { commit_sha: 'f'.repeat(40) }]);

  // Person B in `pilot` (the submitter never approves G3; only Person A submits by default).
  await page.goto(`${LOCAL}/dashboard/#/intents/INT-2026-0001`);
  const pilot = page.getByRole('region', { name: 'Submit the plan' });
  await pilot.getByRole('button', { name: 'Submit plan' }).click();
  await expect(pilot.getByRole('alert')).toHaveText(
    'Your role in this project does not allow you to submit a plan (access.plan_submit_roles).',
  );
  expect(w.writes).toEqual([
    'POST /v1/intents/INT-2026-0009/plans',
    'POST /v1/intents/INT-2026-0009/plans',
    'POST /v1/intents/INT-2026-0001/plans',
  ]);
});

test('U08 AC2: build an Evidence Pack; nothing changed builds no new version', async ({ page }) => {
  await signedIn(page);
  const w = watchWrites(page);
  await page.goto(`${LOCAL}/dashboard/#/intents/INT-2026-0001`);
  const packs = page.getByRole('region', { name: 'Evidence Packs' });
  await packs.getByRole('button', { name: 'Build Evidence Pack' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Evidence Pack' })).toHaveText(
    'Evidence Pack version 1 built.',
  );

  await page.goto(`${LOCAL}/dashboard/#/intents/INT-2026-0006`);
  const six = page.getByRole('region', { name: 'Evidence Packs' });
  await six.getByRole('button', { name: 'Build Evidence Pack' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Nothing changed' })).toHaveText(
    'Nothing changed since version 1: no new version was built.',
  );
  expect(w.writes).toEqual([
    'POST /v1/intents/INT-2026-0001/evidence-packs',
    'POST /v1/intents/INT-2026-0006/evidence-packs',
  ]);
});

test('U08 AC2: the L1 proposal is saved with the CLI; the page never asks for it', async ({
  page,
}) => {
  await signedIn(page);
  const asked: string[] = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.endsWith('/proposal')) asked.push(req.url());
  });
  await page.goto(`${LOCAL}/dashboard/#/intents/INT-2026-0010`);
  await expect(
    page.getByText(
      'sdlc evidence proposal INT-2026-0010 --run 00000000-0000-4000-8000-000000000604 --output <file>',
    ),
  ).toBeVisible();
  expect(asked).toEqual([]);
});

test('U08: signed in with a token: no create, plan or pack action', async ({ page }) => {
  await page.goto(`${LOCAL}/dashboard/`);
  await page.getByLabel('Personal API token').fill(process.env.SDLC_DASHBOARD_E2E_TOKEN!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Where every intent waits' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New intent' })).toHaveCount(0);
  await page.goto(`${LOCAL}/dashboard/#/intents/INT-2026-0006`);
  await expect(page.getByRole('heading', { name: 'Evidence Packs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit plan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Build Evidence Pack' })).toHaveCount(0);
});

for (const width of [375, 768, 1440]) {
  test(`U08: the create form and the intent actions at ${width} px, light and dark`, async ({
    page,
  }) => {
    await signedIn(page);
    const screens = [
      ['create', '#/intents', true],
      ['intent', '#/intents/INT-2026-0009', false],
    ] as const;
    for (const [name, route, modal] of screens) {
      await page.goto(`${LOCAL}/dashboard/${route}`);
      if (modal) {
        await page.getByRole('button', { name: 'New intent' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
      } else {
        await expect(page.getByRole('button', { name: 'Submit plan' })).toBeVisible();
      }
      for (const scheme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${name} ${scheme}`).toBeLessThanOrEqual(0);
        await page.screenshot({
          path: path.join(SHOTS, `${width}-${scheme}-u08-${name}.png`),
          fullPage: true,
        });
      }
    }
  });
}
