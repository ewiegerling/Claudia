import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const baseUrl = process.env.RECOVERY_TEST_URL;
const username = process.env.RECOVERY_TEST_USER;
const testSecret = process.env.RECOVERY_TEST_PASSWORD;
if (!baseUrl || !username || !testSecret) {
  throw new Error('Set RECOVERY_TEST_URL, RECOVERY_TEST_USER, and RECOVERY_TEST_PASSWORD for the production audit.');
}
delete process.env.RECOVERY_TEST_PASSWORD;

const browserEnvironment = {
  ...process.env,
  LD_LIBRARY_PATH: '/opt/playwright-libs/usr/lib/x86_64-linux-gnu',
  FONTCONFIG_PATH: '/opt/playwright-libs/etc/fonts',
  FONTCONFIG_FILE: 'fonts.conf',
  FONTCONFIG_SYSROOT: '/opt/playwright-libs',
};

const browser = await chromium.launch({ headless: true, env: browserEnvironment });
let checks = 0;
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 780 }]) {
    const context = await browser.newContext({
      viewport,
      isMobile: viewport.width < 600,
      hasTouch: viewport.width < 600,
      httpCredentials: Object.fromEntries([['username', username], ['password', testSecret]]),
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      const text = message.text();
      const expectedLocalHttpWarning = text.includes('Cross-Origin-Opener-Policy header has been ignored')
        && baseUrl.startsWith('http://');
      if (message.type() === 'error' && !expectedLocalHttpWarning) errors.push(text);
    });
    const response = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    assert.match(response.headers()['content-security-policy'], /default-src 'none'/);
    await page.waitForFunction(() => document.querySelector('#readiness')?.textContent !== 'SCANNING');
    assert.equal(await page.locator('.service-card').count(), 5);
    assert.equal(await page.locator('.ambient-one').count(), 1);
    assert.equal(await page.locator('.ambient-two').count(), 1);
    assert.equal(await page.locator('#password-form').isVisible(), true);
    assert.equal(await page.locator('#new-password').getAttribute('minlength'), '12');
    assert.equal(await page.locator('.backup-panel').isVisible(), true);
    assert.equal(await page.locator('#create-backup').isVisible(), true);
    await page.waitForFunction(() => !document.querySelector('#backup-capacity')?.textContent.includes('Loading'));
    assert.match(await page.locator('#backup-capacity').textContent(), /local slots used|unavailable/i);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lilac').trim()), '#b9a7ff');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mint').trim()), '#71efc3');
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#0b0a10');
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(layout.scroll <= layout.width, `${viewport.width}px production layout overflows`);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    assert.deepEqual(accessibility.violations, [], `${viewport.width}px production accessibility: ${accessibility.violations.map((item) => item.id).join(', ')}`);
    assert.deepEqual(errors, [], `${viewport.width}px browser errors`);
    checks += 15;
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`Production recovery browser audit passed: ${checks} checks across desktop, mobile, and narrow-mobile viewports.`);
