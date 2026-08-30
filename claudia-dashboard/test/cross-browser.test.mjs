import assert from 'node:assert/strict';
import test from 'node:test';
import { firefox } from 'playwright';

const BASE_URL = process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:4317';
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const FIREFOX_ENV = process.env;

test('Firefox desktop and mobile smoke audit', async (t) => {
  const browser = await firefox.launch({ headless: true, env: FIREFOX_ENV });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('#cpu-value')?.textContent !== '—', null, { timeout: 20_000 });
        for (const view of ['overview', 'memory', 'projects', 'dreams']) {
          await page.evaluate((target) => document.querySelector(`[data-nav="${target}"]`)?.click(), view);
          await page.locator(`#view-${view}`).waitFor({ state: 'visible' });
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
