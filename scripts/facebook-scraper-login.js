#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const projectRoot = path.resolve(__dirname, '..');
const configPath = process.env.FB_BOT_CONFIG || path.join(projectRoot, 'config', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const scraper = config.scraper || {};
const userDataDir = scraper.userDataDir || path.join(projectRoot, 'state', 'browser-profile');
const email = process.env.FB_LOGIN_EMAIL || '';
const password = process.env.FB_LOGIN_PASSWORD || '';

fs.mkdirSync(userDataDir, { recursive: true });

(async () => {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: Number(scraper.width || 1365), height: Number(scraper.height || 900) },
    locale: scraper.locale || 'en-US',
    timezoneId: scraper.timezoneId || 'Africa/Cairo',
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  console.log(`Opened Facebook with persistent profile: ${userDataDir}`);
  if (email && password) {
    const emailInput = page.locator('input[name="email"]').first();
    const passInput = page.locator('input[name="pass"]').first();
    if (await emailInput.count().catch(() => 0)) {
      await emailInput.fill(email);
      await passInput.fill(password);
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 20000 }),
        page.locator('button[name="login"], [data-testid="royal_login_button"]').first().click()
      ]);
      await page.waitForTimeout(5000);
    }
    const currentUrl = page.url();
    if (/checkpoint|two_step|login|recover/i.test(currentUrl)) {
      console.log(`Facebook still needs manual action at: ${currentUrl}`);
      console.log('Complete the visible browser flow manually, then press Enter here to close.');
    } else {
      console.log(`Login flow reached: ${currentUrl}`);
      console.log('If the visible browser is logged in, press Enter here to close.');
    }
  } else {
    console.log('Log in manually, pass any checkpoint if Facebook asks, then press Enter here to close.');
  }
  process.stdin.resume();
  process.stdin.once('data', async () => {
    await context.close();
    process.exit(0);
  });
})();
