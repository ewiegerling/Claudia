import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE_URL = process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:4317';
const BROWSER_ENV = process.env;

test('WCAG 2.2 AA automated accessibility audit', async (t) => {
  const browser = await chromium.launch({ headless: true, env: BROWSER_ENV });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 780 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
        const page = await context.newPage();
        await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('#cpu-value')?.textContent !== '—', null, { timeout: 20_000 });
        for (const view of ['overview', 'memory', 'projects', 'dreams']) {
          await page.evaluate((target) => document.querySelector(`[data-nav="${target}"]`)?.click(), view);
          await page.locator(`#view-${view}`).waitFor({ state: 'visible' });
          const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
          assert.deepEqual(results.violations, [], `${view} at ${viewport.width}px: ${results.violations.map((item) => `${item.id} (${item.nodes.length})`).join(', ')}`);
        }

        const diagnostics = await page.evaluate(() => {
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          };
          const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
          const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
          const nameless = [...document.querySelectorAll('button, a[href], input')].filter(visible).filter((element) => !(element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.textContent.trim() || element.getAttribute('placeholder'))).length;
          const tinyTargets = [...document.querySelectorAll('button, a[href], input')].filter(visible).map((element) => {
            const rect = element.getBoundingClientRect();
            return { tag: element.tagName, label: element.getAttribute('aria-label') || element.textContent.trim(), width: rect.width, height: rect.height };
          }).filter((item) => item.width < 24 || item.height < 24);
          return { duplicates: [...new Set(duplicates)], nameless, tinyTargets };
        });
        assert.deepEqual(diagnostics.duplicates, []);
        assert.equal(diagnostics.nameless, 0);
        assert.deepEqual(diagnostics.tinyTargets, []);
        await context.close();
      });
    }
  } finally {
    await browser.close();
  }
});
