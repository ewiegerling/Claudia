import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { startTestServer, TEST_SECRET, TEST_USER } from './helpers.mjs';

const BROWSER_ENV = process.env;

test('WCAG 2.2 AA audit passes at desktop and narrow mobile sizes', async (t) => {
  const instance = await startTestServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, env: BROWSER_ENV });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 780 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const context = await browser.newContext({
          viewport,
          isMobile: viewport.width < 600,
          hasTouch: viewport.width < 600,
          reducedMotion: 'reduce',
          httpCredentials: Object.fromEntries([['username', TEST_USER], ['password', TEST_SECRET]]),
        });
        const page = await context.newPage();
        await page.goto(`${instance.baseUrl}/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector('#readiness')?.textContent === 'NOMINAL');
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
        assert.deepEqual(results.violations, [], `${viewport.width}px: ${results.violations.map((item) => `${item.id} (${item.nodes.length})`).join(', ')}`);

        await page.locator('[data-action="restart_claudia"]').click();
        const dialogResults = await new AxeBuilder({ page }).include('#confirm-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
        assert.deepEqual(dialogResults.violations, [], `dialog at ${viewport.width}px: ${dialogResults.violations.map((item) => item.id).join(', ')}`);
        await context.close();
      });
    }
  } finally {
    await browser?.close();
    await instance.close();
  }
});
