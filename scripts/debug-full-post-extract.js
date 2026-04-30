#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const projectRoot = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config', 'config.json'), 'utf8'));
const targetUrl = process.argv[2] || 'https://www.facebook.com/groups/psychologyst/posts/10165167393679878/';
const marker = process.argv[3] || 'I do not understand';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeEscapedJsonText(value) {
  return String(value || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

async function clickAllExpands(page) {
  const labels = [
    'See more',
    'See original',
    'Ещё',
    'Показать ещё',
    'Ще',
    'Показати більше',
  ];
  for (let pass = 0; pass < 4; pass += 1) {
    let clicked = 0;
    for (const label of labels) {
      const locator = page.getByText(label, { exact: false });
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 20); index += 1) {
        const candidate = locator.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        await candidate.scrollIntoViewIfNeeded().catch(() => {});
        await candidate.click({ timeout: 800 }).then(() => { clicked += 1; }).catch(() => {});
        await page.waitForTimeout(250);
      }
    }
    if (!clicked) break;
    await page.waitForTimeout(1200);
  }
}

async function extractAroundMarker(page, markerText) {
  return page.evaluate((needle) => {
    function cleanInner(value) {
      return (value || '').replace(/\s+/g, ' ').trim();
    }
    function pathFor(node) {
      const parts = [];
      for (let current = node; current && current.nodeType === 1 && parts.length < 8; current = current.parentElement) {
        const label = current.tagName.toLowerCase();
        const role = current.getAttribute('role');
        const cls = String(current.className || '').split(/\s+/).slice(0, 3).join('.');
        parts.push(`${label}${role ? `[role=${role}]` : ''}${cls ? `.${cls}` : ''}`);
      }
      return parts.join(' < ');
    }
    const matches = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = cleanInner(node.innerText);
      if (!text || !text.includes(needle)) continue;
      matches.push({
        tag: node.tagName,
        role: node.getAttribute('role'),
        path: pathFor(node),
        length: text.length,
        text: text.slice(0, 6000),
      });
    }
    return matches
      .sort((a, b) => b.length - a.length)
      .slice(0, 20);
  }, markerText);
}

async function testUrl(context, url) {
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await clickAllExpands(page);
  await page.waitForTimeout(1500);

  const bodyText = clean(await page.locator('body').innerText().catch(() => ''));
  const html = await page.content();
  const htmlDecoded = decodeEscapedJsonText(html);
  const htmlIndex = htmlDecoded.indexOf(marker);
  const bodyIndex = bodyText.indexOf(marker);
  const matches = await extractAroundMarker(page, marker);

  const result = {
    url,
    finalUrl: page.url(),
    bodyLength: bodyText.length,
    bodyIndex,
    bodyAroundMarker: bodyIndex >= 0 ? bodyText.slice(Math.max(0, bodyIndex - 1000), bodyIndex + 5000) : null,
    htmlIndex,
    htmlAroundMarker: htmlIndex >= 0 ? htmlDecoded.slice(Math.max(0, htmlIndex - 1000), htmlIndex + 5000) : null,
    domMatches: matches,
  };
  await page.close();
  return result;
}

async function main() {
  const urls = [
    targetUrl,
    targetUrl.replace('www.facebook.com', 'm.facebook.com'),
    targetUrl.replace('www.facebook.com', 'mbasic.facebook.com'),
  ];

  const context = await chromium.launchPersistentContext(config.scraper?.userDataDir || path.join(projectRoot, 'state', 'browser-profile'), {
    headless: config.scraper?.headless !== false,
    viewport: { width: 1365, height: 1000 },
    locale: 'en-US',
    timezoneId: 'Africa/Cairo',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const results = [];
    for (const url of urls) {
      console.error(`testing ${url}`);
      results.push(await testUrl(context, url));
    }
    const file = path.join(projectRoot, 'state', 'parent-finds', `full-post-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
    console.log(file);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
