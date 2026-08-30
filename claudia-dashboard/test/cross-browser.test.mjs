import assert from 'node:assert/strict';
import test from 'node:test';
import { firefox } from 'playwright';

const BASE_URL = process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:4317';
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const SANITIZED_PROCESS_ENV = { ...process.env };
const TEST_USER = SANITIZED_PROCESS_ENV.DASHBOARD_TEST_USER;
const TEST_SECRET = SANITIZED_PROCESS_ENV['DASHBOARD_TEST_PASSWORD'];
delete SANITIZED_PROCESS_ENV.DASHBOARD_TEST_USER;
delete SANITIZED_PROCESS_ENV.DASHBOARD_TEST_PASSWORD;
const hasTestUser = TEST_USER !== undefined;
const hasTestSecret = TEST_SECRET !== undefined;
if (hasTestUser !== hasTestSecret) throw new Error('Set both DASHBOARD_TEST_USER and DASHBOARD_TEST_PASSWORD for authenticated audits.');
if (hasTestUser && (!TEST_USER || !TEST_SECRET)) throw new Error('Dashboard test credentials must be non-empty.');
const HTTP_CREDENTIALS = hasTestUser
  ? Object.fromEntries([['username', TEST_USER], ['password', TEST_SECRET]])
  : null;

const FIREFOX_ENV = process.env;

function withHttpCredentials(options = {}) {
  return HTTP_CREDENTIALS ? { ...options, httpCredentials: HTTP_CREDENTIALS } : options;
}

test('Firefox desktop and mobile smoke audit', async (t) => {
  const browser = await firefox.launch({ headless: true, env: FIREFOX_ENV });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const context = await browser.newContext(withHttpCredentials({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 }));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('#cpu-value')?.textContent !== '—', null, { timeout: 20_000 });
        for (const view of ['overview', 'memory', 'voice', 'atlas', 'projects', 'dreams', 'settings']) {
          await page.evaluate((target) => document.querySelector(`[data-nav="${target}"]`)?.click(), view);
          await page.locator(`#view-${view}`).waitFor({ state: 'visible' });
          if (view === 'atlas') {
            await page.waitForFunction(() => {
              const loading = document.querySelector('#atlas-loading');
              const canvas = document.querySelector('#atlas-canvas');
              return loading?.hidden && canvas?.width > 0 && canvas?.height > 0;
            }, null, { timeout: 30_000 });
            assert.equal(await page.locator('[data-atlas-region]').count(), 6);
            assert.equal(await page.locator('#atlas-canvas').isVisible(), true);
            await page.locator('#atlas-list-toggle').click();
            assert.ok(await page.locator('.atlas-node-button').count() > 0);
            await page.locator('#atlas-index-close').click();
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 1, `${view} overflows by ${overflow}px at ${viewport.width}px`);
        }
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  } finally {
    await browser.close();
  }
});
