import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

const BASE_URL = process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:4317';
const OUTPUT_DIR = process.env.DASHBOARD_AUDIT_DIR || '/tmp/claudia-dashboard-audit';
const BROWSER_ENV = process.env;

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('requestfailed', (request) => {
    if (request.resourceType() !== 'eventsource') errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`);
  });
  return errors;
}

async function assertNoOverflow(page, label) {
  const result = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(result.scroll <= result.client + 1, `${label} horizontally overflows: ${JSON.stringify(result)}`);
}

async function waitForDashboard(page) {
  await page.waitForFunction(() => document.querySelector('#cpu-value')?.textContent !== '—', null, { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector('#sidebar-connection')?.textContent !== 'Connecting', null, { timeout: 20_000 });
}

test('production-style browser audit', async (t) => {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, env: BROWSER_ENV });
  try {
    await t.test('desktop overview is live, stable, and interactive', async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = watchErrors(page);
      const response = await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200);
      await waitForDashboard(page);
      assert.match(await page.locator('#overall-status').innerText(), /nominal|degraded|critical/i);
      assert.ok(await page.locator('.service-row').count() >= 3);
      assert.ok(await page.locator('.metric-tile').count() === 4);
      await page.locator('#service-refresh').click();
      await page.locator('.toast').waitFor();
      await assertNoOverflow(page, 'desktop overview');
      await page.screenshot({ path: `${OUTPUT_DIR}/overview-desktop.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test('all primary views work from desktop navigation', async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = watchErrors(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await waitForDashboard(page);
      for (const view of ['memory', 'projects', 'dreams', 'overview']) {
        await page.locator(`.side-nav [data-nav="${view}"]`).click();
        await page.locator(`#view-${view}`).waitFor({ state: 'visible' });
        assert.equal(await page.locator('body').getAttribute('data-view'), view);
        assert.equal(await page.locator(`.side-nav [data-nav="${view}"]`).getAttribute('aria-current'), 'page');
        await assertNoOverflow(page, `desktop ${view}`);
      }
      await page.screenshot({ path: `${OUTPUT_DIR}/overview-1280.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test('memory search and sanitized reader operate with the keyboard', async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = watchErrors(page);
      await page.goto(`${BASE_URL}/#memory`, { waitUntil: 'domcontentloaded' });
      await page.locator('.document-button').first().waitFor();
      await page.locator('#memory-search').fill('Claudia');
      assert.ok(await page.locator('.document-button').count() > 0);
      await page.locator('.document-button').first().click();
      assert.ok(await page.locator('#document-viewer .markdown h1, #document-viewer .markdown h2').count() > 0);
      assert.equal(await page.locator('#document-viewer script').count(), 0);
      await assertNoOverflow(page, 'memory reader');
      await page.screenshot({ path: `${OUTPUT_DIR}/memory-desktop.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test('project detail and dream journal render real derived data', async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = watchErrors(page);
      await page.goto(`${BASE_URL}/#projects`, { waitUntil: 'domcontentloaded' });
      await page.locator('.project-card').first().waitFor();
      await page.locator('.project-card').first().click();
      assert.ok((await page.locator('#project-detail h2').innerText()).length > 0);
      await page.screenshot({ path: `${OUTPUT_DIR}/projects-desktop.png`, fullPage: true });
      await page.locator('.side-nav [data-nav="dreams"]').click();
      await page.locator('#view-dreams').waitFor({ state: 'visible' });
      assert.match(await page.locator('#dream-state').innerText(), /enabled|paused/i);
      assert.ok(await page.locator('.dream-card').count() >= 1);
      await assertNoOverflow(page, 'dream journal');
      await page.screenshot({ path: `${OUTPUT_DIR}/dreams-desktop.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test('command palette supports shortcut, arrow navigation, escape, and focus restoration', async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = watchErrors(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await waitForDashboard(page);
      await page.locator('#command-trigger').focus();
      await page.keyboard.press('Control+K');
      await page.locator('#command-palette').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#command-input').evaluate((element) => element === document.activeElement), true);
      await page.locator('#command-input').fill('Nightly synthesis');
      assert.ok(await page.locator('.palette-result').count() > 0);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.locator('#view-dreams').waitFor({ state: 'visible' });
      await page.locator('#command-trigger').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#command-palette').getAttribute('open'), null);
      assert.equal(await page.locator('#command-trigger').evaluate((element) => element === document.activeElement), true);
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test('automatic refresh can be paused without losing manual refresh', async () => {
      const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      const errors = watchErrors(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await waitForDashboard(page);
      await page.locator('#live-toggle').click();
      assert.equal(await page.locator('#live-toggle').getAttribute('aria-pressed'), 'false');
      assert.match(await page.locator('#sidebar-connection').innerText(), /paused/i);
      await page.locator('#refresh-button').click();
      await page.locator('.toast').waitFor();
      await page.locator('#live-toggle').click();
      assert.equal(await page.locator('#live-toggle').getAttribute('aria-pressed'), 'true');
      assert.deepEqual(errors, []);
      await page.close();
    });

    const phoneViewports = [
      { width: 320, height: 568, label: '320-floor' },
      { width: 360, height: 800, label: 'android-small' },
      { width: 390, height: 844, label: 'iphone-typical' },
      { width: 430, height: 932, label: 'phone-large' },
      { width: 667, height: 375, label: 'phone-landscape' },
    ];
    for (const viewport of phoneViewports) {
      await t.test(`mobile reflow and navigation at ${viewport.label}`, async () => {
        const context = await browser.newContext({ viewport, isMobile: viewport.width < viewport.height, hasTouch: true });
        const page = await context.newPage();
        const errors = watchErrors(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        await waitForDashboard(page);
        assert.equal(await page.locator('.mobile-nav').isVisible(), true);
        for (const view of ['memory', 'projects', 'dreams', 'overview']) {
          await page.locator(`.mobile-nav [data-nav="${view}"]`).click();
          await page.locator(`#view-${view}`).waitFor({ state: 'visible' });
          await assertNoOverflow(page, `${viewport.label} ${view}`);
        }
        if (viewport.label === 'iphone-typical' || viewport.label === '320-floor') {
          await page.screenshot({ path: `${OUTPUT_DIR}/overview-${viewport.label}.png`, fullPage: true });
        }
        assert.deepEqual(errors, []);
        await context.close();
      });
    }

    await t.test('tablet layouts reflow without desktop or phone compromises', async () => {
      for (const viewport of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
        const page = await browser.newPage({ viewport });
        const errors = watchErrors(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        await waitForDashboard(page);
        await assertNoOverflow(page, `tablet ${viewport.width}x${viewport.height}`);
        assert.deepEqual(errors, []);
        await page.close();
      }
    });

    await t.test('reduced motion and text spacing remain usable', async () => {
      const context = await browser.newContext({ viewport: { width: 320, height: 780 }, isMobile: true, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = watchErrors(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await waitForDashboard(page);
      const duration = await page.locator('.status-orbit').evaluate((element) => getComputedStyle(element, '::before').animationDuration);
      assert.match(duration, /1e-05s|0\.00001|0\.01ms|0s/);
      await page.evaluate(() => document.body.classList.add('audit-text-spacing'));
      await assertNoOverflow(page, '320px with text spacing');
      assert.deepEqual(errors, []);
      await context.close();
    });

    await t.test('skip link and logical keyboard navigation are present', async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('.skip-link').evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#main-content').evaluate((element) => element === document.activeElement), true);
      await page.close();
    });
  } finally {
    await browser.close();
  }
});
