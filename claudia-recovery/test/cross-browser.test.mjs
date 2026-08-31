import assert from 'node:assert/strict';
import test from 'node:test';
import { firefox } from 'playwright';
import { startTestServer, TEST_SECRET, TEST_USER } from './helpers.mjs';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const FIREFOX_ENV = process.env;

test('Firefox renders the recovery console at desktop and mobile widths', async (t) => {
  const instance = await startTestServer();
  const browser = await firefox.launch({ headless: true, env: FIREFOX_ENV });
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const context = await browser.newContext({
          viewport,
          httpCredentials: Object.fromEntries([['username', TEST_USER], ['password', TEST_SECRET]]),
        });
        const page = await context.newPage();
        await page.goto(`${instance.baseUrl}/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector('#readiness')?.textContent === 'NOMINAL');
        assert.equal(await page.locator('.service-card').count(), 5);
        assert.equal(await page.locator('#connection-label').textContent(), 'Recovery link online');
        const widths = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]);
        assert.ok(widths[1] <= widths[0]);
        await context.close();
      });
    }
  } finally {
    await browser.close();
    await instance.close();
  }
});
