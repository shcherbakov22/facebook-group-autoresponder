#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { classifyWithOpenRouter } = require('./openrouter-classifier.js');

const projectRoot = path.resolve(__dirname, '..');
const configPath = process.env.FB_BOT_CONFIG || path.join(projectRoot, 'config', 'config.json');
const outputDir = process.env.FB_GLOBAL_SEARCH_DIR || path.join(projectRoot, 'state', 'semantic-tests');
const maxResultsPerSearch = Number(process.env.FB_GLOBAL_SEARCH_RESULTS || 10);
const scrollsPerSearch = Number(process.env.FB_GLOBAL_SEARCH_SCROLLS || 4);
const terms = (process.env.FB_GLOBAL_SEARCH_TERMS || [
  'ребенок ничего не делает',
  'ребёнок ничего не делает',
  'подросток ничего не хочет',
  'ребенок не хочет учиться',
  'подросток не хочет учиться',
  'не делает уроки ребенок',
  'сидит в телефоне ребенок',
  'играет целыми днями подросток',
  'нет мотивации подросток',
  'дитина нічого не робить',
  'підліток не хоче вчитися',
  'дитина сидить у телефоні',
].join('|')).split('|').map((term) => term.trim()).filter(Boolean);

function searchUrl(query) {
  return `https://www.facebook.com/search/posts/?q=${encodeURIComponent(query)}`;
}

async function isLoginRequired(page) {
  const url = page.url();
  if (/\/login|checkpoint|recover\/initiate|two_step/i.test(url)) return true;
  const loginControls = await page.locator('input[name="email"], input[name="pass"], form[action*="login"]').count().catch(() => 0);
  return loginControls > 0;
}

async function scrapeResults(page) {
  return page.evaluate(({ maxResults }) => {
    function clean(value) {
      return (value || '').replace(/\s+/g, ' ').trim();
    }
    function permalink(node) {
      const links = [...node.querySelectorAll('a[href]')].map((a) => a.href);
      const hit = links.find((href) => /facebook\.com\/groups\/|\/posts\/|\/permalink\/|story_fbid=|multi_permalinks=/.test(href));
      return hit?.split('?')[0] || null;
    }
    const nodes = [...document.querySelectorAll('[role="article"]')];
    const results = [];
    const seen = new Set();
    for (const node of nodes) {
      const text = clean(node.innerText);
      if (!text || text.length < 30) continue;
      const url = permalink(node);
      const key = url || text.slice(0, 300);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ text, permalink: url });
      if (results.length >= maxResults) break;
    }
    return results;
  }, { maxResults: maxResultsPerSearch });
}

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 700);
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.mkdirSync(outputDir, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(),
    terms,
    results: [],
    errors: [],
  };

  const context = await chromium.launchPersistentContext(config.scraper?.userDataDir || path.join(projectRoot, 'state', 'browser-profile'), {
    headless: config.scraper?.headless !== false,
    viewport: { width: 1365, height: 900 },
    locale: 'en-US',
    timezoneId: 'Africa/Cairo',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const seen = new Set();
  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(4000);
    for (const term of terms) {
      console.error(`global search term="${term}"`);
      try {
        await page.goto(searchUrl(term), { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4500);
        if (await isLoginRequired(page)) throw new Error(`Facebook login/checkpoint at ${page.url()}`);
        for (let i = 0; i < scrollsPerSearch; i += 1) {
          await page.mouse.wheel(0, 1800);
          await page.waitForTimeout(1200);
        }
        const scraped = await scrapeResults(page);
        console.error(`term="${term}" scraped=${scraped.length}`);
        for (const item of scraped) {
          const key = item.permalink || item.text.slice(0, 300);
          if (seen.has(key)) continue;
          seen.add(key);
          const result = {
            term,
            permalink: item.permalink,
            snippet: snippet(item.text),
          };
          try {
            result.semantic = await classifyWithOpenRouter({
              text: item.text,
              groupName: 'global-search',
              targetType: 'post',
              config,
            });
          } catch (error) {
            result.error = error.message;
          }
          report.results.push(result);
        }
      } catch (error) {
        report.errors.push({ term, error: error.message });
      }
    }
  } finally {
    await context.close();
  }

  report.finishedAt = new Date().toISOString();
  const file = path.join(outputDir, `facebook-global-search-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: file,
    total: report.results.length,
    relevant: report.results.filter((item) => item.semantic?.relevant).length,
    errors: report.errors,
    relevantSnippets: report.results
      .filter((item) => item.semantic?.relevant)
      .map((item) => ({
        term: item.term,
        confidence: item.semantic.confidence,
        category: item.semantic.category,
        reason: item.semantic.reason,
        snippet: item.snippet,
        permalink: item.permalink,
      })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
