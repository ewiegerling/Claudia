import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startTestServer, TEST_SECRET, TEST_USER } from './helpers.mjs';

const BROWSER_ENV = process.env;

test('Chromium desktop and mobile recovery journeys', async (t) => {
  const live = await startTestServer();
  const browser = await chromium.launch({ headless: true, env: BROWSER_ENV });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 780 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const context = await browser.newContext({
          viewport,
          isMobile: viewport.width < 600,
          hasTouch: viewport.width < 600,
          httpCredentials: Object.fromEntries([['username', TEST_USER], ['password', TEST_SECRET]]),
        });
        const page = await context.newPage();
        await page.goto(`${live.baseUrl}/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector('#readiness')?.textContent === 'NOMINAL');
        assert.equal(await page.locator('.service-card').count(), 5);
        assert.equal(await page.locator('.action-card').count(), 4);
        assert.equal(await page.locator('#vault-commit').textContent(), 'abc123def456');
        const layout = await page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          duplicates: [...document.querySelectorAll('[id]')].map((node) => node.id).filter((id, index, all) => all.indexOf(id) !== index),
        }));
        assert.ok(layout.scrollWidth <= layout.viewport, `horizontal overflow: ${JSON.stringify(layout)}`);
        assert.deepEqual(layout.duplicates, []);

        await page.locator('[data-action="restart_gateway"]').click();
        await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
        assert.match(await page.locator('#confirm-impact').textContent(), /sessions may reconnect/i);
        await page.locator('button[value="cancel"]').click();
        await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });

        if (viewport.width < 600) {
          const smallTargets = await page.evaluate(() => [...document.querySelectorAll('button, a[href]')].filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
          }).map((element) => ({ label: element.textContent.trim(), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
          assert.deepEqual(smallTargets, []);
        }
        await context.close();
      });
    }
  } finally {
    await browser.close();
    await live.close();
  }
});
