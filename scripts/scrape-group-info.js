#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const projectRoot = path.resolve(__dirname, '..');
const configPath = process.env.FB_BOT_CONFIG || path.join(projectRoot, 'config', 'config.json');
const outputDir = process.env.FB_GROUP_INFO_DIR || path.join(projectRoot, 'state', 'group-info');
const maxPosts = Number(process.env.FB_GROUP_INFO_MAX_POSTS || 25);
const scrolls = Number(process.env.FB_GROUP_INFO_SCROLLS || 8);
const shouldExpandText = process.env.FB_GROUP_INFO_EXPAND_TEXT !== '0';

function normalizeGroupUrl(group) {
  if (group.url) return group.url.replace(/\/$/, '');
  if (String(group.id || '').startsWith('http')) return String(group.id).replace(/\/$/, '');
  return `https://www.facebook.com/groups/${group.id}`;
}

async function isLoginRequired(page) {
  const url = page.url();
  if (/\/login|checkpoint|recover\/initiate|two_step/i.test(url)) return true;
  const loginControls = await page.locator('input[name="email"], input[name="pass"], form[action*="login"]').count().catch(() => 0);
  return loginControls > 0;
}

async function clickSafe(page, selector, max = 5) {
  const count = await page.locator(selector).count().catch(() => 0);
  for (let i = 0; i < Math.min(count, max); i += 1) {
    await page.locator(selector).nth(i).click({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(250).catch(() => {});
  }
}

async function expandText(page) {
  const selectors = [
    'div[role="button"]:has-text("See more")',
    'span:has-text("See more")',
    'div[role="button"]:has-text("Ещё")',
    'span:has-text("Ещё")',
    'div[role="button"]:has-text("Ще")',
    'span:has-text("Ще")',
  ];
  for (const selector of selectors) await clickSafe(page, selector, 20);
}

async function scrapeGroup(page, group) {
  const url = normalizeGroupUrl(group);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);
  if (await isLoginRequired(page)) throw new Error(`Facebook login/checkpoint at ${page.url()}`);
  if (shouldExpandText) await expandText(page);
  for (let i = 0; i < scrolls; i += 1) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1300);
    if (shouldExpandText) await expandText(page);
  }

  return page.evaluate(({ maxPosts, groupUrl }) => {
    function clean(value) {
      return (value || '').replace(/\s+/g, ' ').trim();
    }
    function linkMatches(href) {
      return /facebook\.com\/groups\/|\/permalink\/|story_fbid=|multi_permalinks=/.test(href || '');
    }
    function permalink(node) {
      const links = [...node.querySelectorAll('a[href]')].map((a) => a.href).filter(linkMatches);
      return links[0]?.split('?')[0] || null;
    }
    function numbersFrom(text) {
      const matches = text.match(/(?:\d[\d\s,.]*)(?:K|M|тыс\.?|тис\.?|млн\.?)?/gi) || [];
      return matches.slice(0, 20);
    }

    const bodyText = clean(document.body.innerText);
    const articles = [...document.querySelectorAll('[role="article"]')];
    const posts = [];
    const seen = new Set();
    const bodyPostPattern = /(Facebook\s+){5,}(.+?)(All reactions:|Like Comment Share|View more answers)/g;
    for (const match of bodyText.matchAll(bodyPostPattern)) {
      const text = clean(match[2]);
      if (!text || text.length < 80) continue;
      const key = text.slice(0, 240);
      if (seen.has(key)) continue;
      seen.add(key);
      const postIdMatch = bodyText.match(/groups\/[^/]+\/posts\/(\d+)/);
      posts.push({
        permalink: postIdMatch ? `${groupUrl}/posts/${postIdMatch[1]}/` : null,
        text: text.slice(0, 2500),
        containsChildTerms: /#child|реб[её]нок|подрост|сын|дочь|дитина|підліт|син|доньк|урок|школ|телефон|мотивац|агресс|агрес|істер|истер|child/i.test(text),
        source: 'body-feed-card',
      });
      if (posts.length >= maxPosts) break;
    }
    for (const node of articles) {
      const text = clean(node.innerText);
      if (!text || text.length < 20) continue;
      const url = permalink(node);
      const key = url || text.slice(0, 240);
      if (seen.has(key)) continue;
      seen.add(key);
      posts.push({
        permalink: url,
        text: text.slice(0, 2500),
        containsChildTerms: /реб[её]нок|подрост|сын|дочь|дитина|підліт|син|доньк|урок|школ|телефон|мотивац|агресс|агрес|істер|истер/i.test(text),
        source: 'article',
      });
      if (posts.length >= maxPosts) break;
    }

    const allLinks = [...document.querySelectorAll('a[href]')].map((a) => ({
      text: clean(a.innerText).slice(0, 160),
      href: a.href.split('?')[0],
    }));

    return {
      finalUrl: location.href,
      title: document.title,
      bodyTextStart: bodyText.slice(0, 3500),
      possibleNumbers: numbersFrom(bodyText),
      navLinks: allLinks.filter((link) => /about|members|people|media|files|events|groups/i.test(link.href) || /About|Members|Участники|Про групу|Інформація|Обсуждение|Discussion|Media/i.test(link.text)).slice(0, 40),
      posts,
      postCount: posts.length,
      childTermPostCount: posts.filter((post) => post.containsChildTerms).length,
    };
  }, { maxPosts, groupUrl: url });
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const groups = (config.groups || []).filter((group) => group.enabled);
  fs.mkdirSync(outputDir, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(),
    groups: [],
  };

  const context = await chromium.launchPersistentContext(config.scraper?.userDataDir || path.join(projectRoot, 'state', 'browser-profile'), {
    headless: config.scraper?.headless !== false,
    viewport: { width: 1365, height: 900 },
    locale: 'en-US',
    timezoneId: 'Africa/Cairo',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(4000);
    for (const group of groups) {
      console.error(`scraping info group="${group.name || group.id}"`);
      const item = {
        id: group.id,
        name: group.name,
        configuredUrl: normalizeGroupUrl(group),
      };
      try {
        Object.assign(item, await scrapeGroup(page, group));
      } catch (error) {
        item.error = error.message;
      }
      report.groups.push(item);
    }
  } finally {
    await context.close();
  }

  report.finishedAt = new Date().toISOString();
  const file = path.join(outputDir, `group-info-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: file,
    groups: report.groups.map((group) => ({
      name: group.name,
      postCount: group.postCount || 0,
      childTermPostCount: group.childTermPostCount || 0,
      error: group.error || null,
      finalUrl: group.finalUrl || null,
      title: group.title || null,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
