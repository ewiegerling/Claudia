import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startTestServer, TEST_SECRET, TEST_USER } from './helpers.mjs';

const BROWSER_ENV = process.env;

test('Chromium desktop and mobile recovery journeys', async (t) => {
  const backup = {
    id: 'claudia-20260831T090000Z-deadbeef',
    createdAt: '2026-08-31T09:00:00.000Z',
    bytes: 2048,
    sha256: 'a'.repeat(64),
    verifiedAt: '2026-08-31T09:00:00.000Z',
    commit: 'abc123def456',
    pendingChanges: 2,
  };
  const verified = [];
  const live = await startTestServer({
    backupLister: async () => [backup],
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, env: BROWSER_ENV });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 780 }]) {
      await t.test(`${viewport.width}x${viewport.height}`, async () => {
        const context = await browser.newContext({
          viewport,
          isMobile: viewport.width < 600,
          hasTouch: viewport.width < 600,
          httpCredentials: Object.fromEntries([['username', TEST_USER], ['password', TEST_SECRET]]),
        });
        const page = await context.newPage();
        await page.route('**/api/backups/verify', async (route) => {
          const payload = route.request().postDataJSON();
          verified.push(payload.backupId);
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, backup }),
          });
        });
        await page.goto(`${live.baseUrl}/`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector('#readiness')?.textContent === 'NOMINAL');
        assert.equal(await page.locator('.service-card').count(), 5);
        assert.equal(await page.locator('.action-card').count(), 4);
        assert.equal(await page.locator('.ambient-one').count(), 1);
        assert.equal(await page.locator('.ambient-two').count(), 1);
        await page.locator('.skip-link').focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'main');
        assert.equal(await page.locator('#vault-commit').textContent(), 'abc123def456');
        assert.equal(await page.locator('#backup-count').textContent(), '1');
        assert.equal(await page.locator('.backup-card').count(), 1);
        assert.match(await page.locator('.backup-card').textContent(), /2\.0 KB/);
        const themed = await page.locator('.backup-panel').evaluate((panel) => {
          const style = getComputedStyle(panel);
          const root = getComputedStyle(document.documentElement);
          return {
            void: root.getPropertyValue('--void').trim(),
            lilac: root.getPropertyValue('--lilac').trim(),
            mint: root.getPropertyValue('--mint').trim(),
            themeColor: document.querySelector('meta[name="theme-color"]')?.content,
            panelBackground: style.backgroundImage,
            panelBorder: style.borderColor,
          };
        });
        assert.equal(themed.void, '#0b0a10');
        assert.equal(themed.lilac, '#b9a7ff');
        assert.equal(themed.mint, '#71efc3');
        assert.equal(themed.themeColor, '#0b0a10');
        assert.match(themed.panelBackground, /linear-gradient/i);
        assert.notEqual(themed.panelBorder, 'rgba(0, 0, 0, 0)');
        assert.equal(await page.locator('#new-password').getAttribute('minlength'), '12');
        assert.equal(await page.locator('#new-password').getAttribute('maxlength'), '128');
        await page.locator('#new-password').fill('A-stronger-recovery-passphrase-42!');
        assert.match(await page.locator('#password-strength-label').textContent(), /strong|excellent/i);
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

        if (viewport.width === 1440) {
          const verificationResponse = page.waitForResponse((response) => response.url().endsWith('/api/backups/verify'));
          await page.locator('.backup-verify').click();
          const response = await verificationResponse;
          assert.equal(response.status(), 200, await response.text());
          await page.locator('#toast').filter({ hasText: 'integrity verified' }).waitFor({ state: 'visible' });
          assert.deepEqual(verified, [backup.id]);
        }

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
    await browser?.close();
    await live.close();
  }
});

test('backup storage failure does not take core recovery status offline', async () => {
  const live = await startTestServer({
    backupLister: async () => { throw new Error('simulated private storage failure'); },
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, env: BROWSER_ENV });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      httpCredentials: Object.fromEntries([['username', TEST_USER], ['password', TEST_SECRET]]),
    });
    const page = await context.newPage();
    await page.goto(`${live.baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#readiness')?.textContent === 'NOMINAL');
    assert.equal(await page.locator('#connection-label').textContent(), 'Recovery link online');
    assert.equal(await page.locator('#backup-count').textContent(), '—');
    assert.match(await page.locator('#backup-list').textContent(), /core recovery status remains online/i);
    await context.close();
  } finally {
    await browser?.close();
    await live.close();
  }
});
