import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE_URL = process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:4317';
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
const BROWSER_ENV = process.env;

function withHttpCredentials(options = {}) {
  return HTTP_CREDENTIALS ? { ...options, httpCredentials: HTTP_CREDENTIALS } : options;
}

test('WCAG 2.2 AA automated accessibility audit', async (t) => {
  const browser = await chromium.launch({ headless: true, env: BROWSER_ENV });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 780 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const context = await browser.newContext(withHttpCredentials({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 }));
        const page = await context.newPage();
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
          }
          const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
          assert.deepEqual(results.violations, [], `${view} at ${viewport.width}px: ${results.violations.map((item) => `${item.id} (${item.nodes.length})`).join(', ')}`);

          if (view === 'atlas') {
            await page.locator('#atlas-list-toggle').click();
            await page.locator('#atlas-index').waitFor({ state: 'visible' });
            const indexResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
            assert.deepEqual(indexResults.violations, [], `open Atlas index at ${viewport.width}px: ${indexResults.violations.map((item) => `${item.id} (${item.nodes.length})`).join(', ')}`);

            if (viewport.width < 600) {
              const undersizedAtlasTargets = await page.evaluate(() => {
                const selectors = [
                  '#atlas-search', '#atlas-list-toggle', '#atlas-labels', '#atlas-motion',
                  '[data-atlas-region]', '#atlas-zoom-in', '#atlas-zoom-out', '#atlas-reset',
                  '#atlas-index-close', '.mobile-nav [data-nav="atlas"]',
                ].join(',');
                return [...document.querySelectorAll(selectors)].filter((element) => {
                  const style = getComputedStyle(element);
                  const rect = element.getBoundingClientRect();
                  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
                }).map((element) => {
                  const rect = element.getBoundingClientRect();
                  return {
                    label: element.getAttribute('aria-label') || element.textContent.trim(),
                    width: Math.round(rect.width * 10) / 10,
                    height: Math.round(rect.height * 10) / 10,
                  };
                }).filter((item) => item.width < 44 || item.height < 44);
              });
              assert.deepEqual(undersizedAtlasTargets, [], `Atlas touch targets below 44px at ${viewport.width}px`);
            }
            await page.locator('#atlas-index-close').click();
          }
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

    await t.test('Brain Atlas respects reduced-motion preference without losing controls', async () => {
      const context = await browser.newContext(withHttpCredentials({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        reducedMotion: 'reduce',
      }));
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/#atlas`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const loading = document.querySelector('#atlas-loading');
        const canvas = document.querySelector('#atlas-canvas');
        return loading?.hidden && canvas?.width > 0 && canvas?.height > 0;
      }, null, { timeout: 30_000 });
      assert.equal(await page.locator('#atlas-motion').getAttribute('aria-pressed'), 'false');
      assert.match(await page.locator('#atlas-canvas').getAttribute('aria-keyshortcuts'), /ArrowLeft/);
      const animations = await page.evaluate(() => [
        getComputedStyle(document.querySelector('.atlas-eyebrow-pulse')).animationDuration,
        getComputedStyle(document.querySelector('.atlas-footer-pulse')).animationDuration,
      ]);
      for (const duration of animations) assert.match(duration, /1e-05s|0\.00001|0\.01ms|0s/);
      await context.close();
    });
  } finally {
    await browser.close();
  }
});
