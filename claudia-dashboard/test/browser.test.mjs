import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

const BASE_URL = process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:4317';
const OUTPUT_DIR = process.env.DASHBOARD_AUDIT_DIR || '/tmp/claudia-dashboard-audit';
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

async function waitForAtlas(page) {
  await page.locator('#view-atlas').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const loading = document.querySelector('#atlas-loading');
    const canvas = document.querySelector('#atlas-canvas');
    const total = document.querySelector('#atlas-node-total')?.textContent;
    return loading?.hidden && total && total !== '—' && canvas?.width > 0 && canvas?.height > 0;
  }, null, { timeout: 30_000 });
}

test('production-style browser audit', async (t) => {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, env: BROWSER_ENV });
  try {
    await t.test('desktop overview is live, stable, and interactive', async () => {
      const page = await browser.newPage(withHttpCredentials({ viewport: { width: 1440, height: 900 } }));
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
      const page = await browser.newPage(withHttpCredentials({ viewport: { width: 1280, height: 800 } }));
      const errors = watchErrors(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await waitForDashboard(page);
      for (const view of ['memory', 'atlas', 'projects', 'dreams', 'settings', 'overview']) {
        await page.locator(`.side-nav [data-nav="${view}"]`).click();
        await page.locator(`#view-${view}`).waitFor({ state: 'visible' });
        if (view === 'atlas') await waitForAtlas(page);
        assert.equal(await page.locator('body').getAttribute('data-view'), view);
        assert.equal(await page.locator(`.side-nav [data-nav="${view}"]`).getAttribute('aria-current'), 'page');
        await assertNoOverflow(page, `desktop ${view}`);
      }
      await page.screenshot({ path: `${OUTPUT_DIR}/overview-1280.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test('Brain Atlas renders live topology and supports every interaction mode', async () => {
      const page = await browser.newPage(withHttpCredentials({ viewport: { width: 1440, height: 1000 } }));
      const errors = watchErrors(page);
      const response = await page.goto(`${BASE_URL}/#atlas`, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200);
      await waitForDashboard(page);
      await waitForAtlas(page);

      assert.equal(await page.locator('[data-atlas-region]').count(), 6);
      assert.ok(Number(await page.locator('#atlas-node-total').innerText()) > 0);
      const canvas = page.locator('#atlas-canvas');
      const dimensions = await canvas.evaluate((element) => ({
        bitmapWidth: element.width,
        bitmapHeight: element.height,
        cssWidth: element.getBoundingClientRect().width,
        cssHeight: element.getBoundingClientRect().height,
      }));
      assert.ok(dimensions.bitmapWidth > 0 && dimensions.bitmapHeight > 0);
      assert.ok(dimensions.cssWidth >= 500 && dimensions.cssHeight >= 400);

      const region = page.locator('[data-atlas-region]').first();
      assert.equal(await region.getAttribute('aria-pressed'), 'true');
      await region.click();
      assert.equal(await region.getAttribute('aria-pressed'), 'false');
      await region.click();
      assert.equal(await region.getAttribute('aria-pressed'), 'true');

      await page.locator('#atlas-labels').click();
      assert.equal(await page.locator('#atlas-labels').getAttribute('aria-pressed'), 'false');
      await page.locator('#atlas-motion').click();
      assert.equal(await page.locator('#atlas-motion').getAttribute('aria-pressed'), 'false');
      await page.locator('#atlas-zoom-in').click();
      await page.locator('#atlas-zoom-out').click();
      await page.locator('#atlas-reset').click();
      await canvas.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('r');

      await page.locator('#atlas-list-toggle').click();
      await page.locator('#atlas-index').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#atlas-list-toggle').getAttribute('aria-expanded'), 'true');
      const indexedNodes = page.locator('.atlas-node-button');
      assert.ok(await indexedNodes.count() > 0);
      const firstTitle = (await indexedNodes.first().locator('strong').innerText()).trim();
      await indexedNodes.first().click();
      await page.locator('#atlas-inspector-content').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#atlas-node-title').innerText()).trim(), firstTitle);
      assert.match(await canvas.getAttribute('aria-label'), /Selected/i);

      await page.locator('#atlas-search').fill(firstTitle);
      assert.ok(await page.locator('.atlas-node-button').count() >= 1);
      assert.match(await page.locator('#atlas-index-summary').innerText(), /matching/i);
      await page.locator('#atlas-search').fill('an-atlas-note-that-cannot-exist-9f26');
      assert.match(await page.locator('#atlas-node-list').innerText(), /No thoughts matched/i);
      await page.locator('#atlas-search').fill('');
      await page.locator('#atlas-index-close').click();
      assert.equal(await page.locator('#atlas-index').isHidden(), true);
      assert.equal(await page.locator('#atlas-list-toggle').getAttribute('aria-expanded'), 'false');

      await assertNoOverflow(page, 'desktop Brain Atlas');
      await page.screenshot({ path: `${OUTPUT_DIR}/atlas-desktop.png`, fullPage: true });
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test('memory search and sanitized reader operate with the keyboard', async () => {
      const page = await browser.newPage(withHttpCredentials({ viewport: { width: 1280, height: 900 } }));
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
      const page = await browser.newPage(withHttpCredentials({ viewport: { width: 1280, height: 900 } }));
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
      const page = await browser.newPage(withHttpCredentials({ viewport: { width: 1280, height: 800 } }));
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
      const page = await browser.newPage(withHttpCredentials({ viewport: { width: 1024, height: 768 } }));
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
        const context = await browser.newContext(withHttpCredentials({ viewport, isMobile: viewport.width < viewport.height, hasTouch: true }));
        const page = await context.newPage();
        const errors = watchErrors(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        await waitForDashboard(page);
        assert.equal(await page.locator('.mobile-nav').isVisible(), true);
        for (const view of ['memory', 'atlas', 'projects', 'dreams', 'overview']) {
          await page.locator(`.mobile-nav [data-nav="${view}"]`).click();
          await page.locator(`#view-${view}`).waitFor({ state: 'visible' });
          if (view === 'atlas') {
            await waitForAtlas(page);
            assert.equal(await page.locator('#atlas-canvas').isVisible(), true);
            assert.equal(await page.locator('[data-atlas-region]').count(), 6);
          }
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
        const page = await browser.newPage(withHttpCredentials({ viewport }));
        const errors = watchErrors(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        await waitForDashboard(page);
        await assertNoOverflow(page, `tablet ${viewport.width}x${viewport.height}`);
        assert.deepEqual(errors, []);
        await page.close();
      }
    });

    await t.test('reduced motion and text spacing remain usable', async () => {
      const context = await browser.newContext(withHttpCredentials({ viewport: { width: 320, height: 780 }, isMobile: true, reducedMotion: 'reduce' }));
      const page = await context.newPage();
      const errors = watchErrors(page);
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await waitForDashboard(page);
      const duration = await page.locator('.status-orbit').evaluate((element) => getComputedStyle(element, '::before').animationDuration);
      assert.match(duration, /1e-05s|0\.00001|0\.01ms|0s/);
      await page.locator('.mobile-nav [data-nav="atlas"]').click();
      await waitForAtlas(page);
      assert.equal(await page.locator('#atlas-motion').getAttribute('aria-pressed'), 'false');
      assert.match(await page.locator('#atlas-canvas').getAttribute('aria-keyshortcuts'), /ArrowLeft/);
      await page.evaluate(() => document.body.classList.add('audit-text-spacing'));
      await assertNoOverflow(page, '320px Atlas with text spacing and reduced motion');
      assert.deepEqual(errors, []);
      await context.close();
    });

    await t.test('skip link and logical keyboard navigation are present', async () => {
      const page = await browser.newPage(withHttpCredentials({ viewport: { width: 1280, height: 800 } }));
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
