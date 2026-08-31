#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';

const username = process.env.DASHBOARD_TEST_USER;
const testSecret = process.env.DASHBOARD_TEST_PASSWORD;
if (!username || !testSecret) throw new Error('Set DASHBOARD_TEST_USER and DASHBOARD_TEST_PASSWORD.');
const formFactors = (process.env.DASHBOARD_LIGHTHOUSE_FORM_FACTORS || 'mobile,desktop')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => ['mobile', 'desktop'].includes(value));
if (!formFactors.length) throw new Error('Set DASHBOARD_LIGHTHOUSE_FORM_FACTORS to mobile and/or desktop.');

const playwrightLibRoot = path.join(os.homedir(), '.cache', 'playwright-libs', 'root');
const playwrightLibraryPath = path.join(playwrightLibRoot, 'usr', 'lib', 'x86_64-linux-gnu');
// The Playwright Chromium bundle on this lean host needs its companion shared
// libraries. Inherit them explicitly so Lighthouse uses the same supported
// runtime as the browser test suite rather than silently failing to launch.
process.env.LD_LIBRARY_PATH = [playwrightLibraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
process.env.FONTCONFIG_PATH = path.join(playwrightLibRoot, 'etc', 'fonts');
process.env.FONTCONFIG_FILE = 'fonts.conf';
process.env.FONTCONFIG_SYSROOT = playwrightLibRoot;

const chrome = await launch({
  chromePath: process.env.LIGHTHOUSE_CHROME_PATH
    || path.join(os.homedir(), '.cache', 'ms-playwright', 'chromium-1234', 'chrome-linux64', 'chrome'),
  chromeFlags: ['--headless', '--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const authorization = `Basic ${Buffer.from(`${username}:${testSecret}`).toString('base64')}`;
  for (const formFactor of formFactors) {
    const result = await lighthouse(
      `${process.env.DASHBOARD_TEST_URL || 'https://dashboard.example.com'}/#voice`,
      { port: chrome.port, output: 'json', logLevel: 'error' },
      {
        extends: 'lighthouse:default',
        settings: {
          onlyCategories: ['performance', 'accessibility', 'best-practices'],
          extraHeaders: { Authorization: authorization },
          formFactor,
          ...(formFactor === 'desktop' ? {
            screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
          } : {}),
        },
      },
    );
    const { lhr } = result;
    const bestPractices = lhr.categories['best-practices'];
    const failures = bestPractices.auditRefs
      .map(({ id, weight }) => ({ id, weight, score: lhr.audits[id]?.score, detail: lhr.audits[id]?.displayValue || lhr.audits[id]?.errorMessage }))
      .filter(({ weight, score }) => weight && score !== 1);
    console.log(JSON.stringify({
      formFactor,
      performance: Math.round(lhr.categories.performance.score * 100),
      accessibility: Math.round(lhr.categories.accessibility.score * 100),
      bestPractices: Math.round(bestPractices.score * 100),
      fcp: lhr.audits['first-contentful-paint'].displayValue,
      lcp: lhr.audits['largest-contentful-paint'].displayValue,
      tbt: lhr.audits['total-blocking-time'].displayValue,
      cls: lhr.audits['cumulative-layout-shift'].displayValue,
      failures,
      warnings: lhr.runWarnings,
    }));
  }
} finally {
  await chrome.kill();
}
