#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { classifyWithOpenRouter } = require('./openrouter-classifier.js');

const projectRoot = path.resolve(__dirname, '..');
const configPath = process.env.FB_BOT_CONFIG || path.join(projectRoot, 'config', 'config.json');
const outputDir = process.env.FB_SEMANTIC_TEST_DIR || path.join(projectRoot, 'state', 'semantic-tests');
const maxGroups = Number(process.env.FB_SEMANTIC_SEARCH_MAX_GROUPS || 10);
const maxResultsPerSearch = Number(process.env.FB_SEMANTIC_SEARCH_RESULTS || 12);
const scrollsPerSearch = Number(process.env.FB_SEMANTIC_SEARCH_SCROLLS || 3);
const classifyTimeoutMs = Number(process.env.FB_SEMANTIC_SEARCH_CLASSIFY_TIMEOUT_MS || 45000);
const searchTerms = (process.env.FB_SEMANTIC_SEARCH_TERMS || [
  'ребенок ничего не делает',
  'ребёнок ничего не делает',
  'подросток ничего не хочет',
  'не хочет учиться',
  'не делает уроки',
  'сидит в телефоне',
  'играет целыми днями',
  'нет мотивации',
  'агрессия подросток',
  'истерики ребенок',
  'дитина нічого не робить',
  'не хоче вчитися',
  'сидить у телефоні',
].join('|')).split('|').map((term) => term.trim()).filter(Boolean);

function normalizeGroupUrl(group) {
  if (group.url) return group.url.replace(/\/$/, '');
  if (String(group.id || '').startsWith('http')) return String(group.id).replace(/\/$/, '');
  return `https://www.facebook.com/groups/${group.id}`;
}

function searchUrl(group, term) {
  return `${normalizeGroupUrl(group)}/search/?q=${encodeURIComponent(term)}`;
}

async function isLoginRequired(page) {
  const url = page.url();
  if (/\/login|checkpoint|recover\/initiate|two_step/i.test(url)) return true;
  const loginControls = await page.locator('input[name="email"], input[name="pass"], form[action*="login"]').count().catch(() => 0);
  return loginControls > 0;
}

async function scrapeResults(page, maxResults) {
  return page.evaluate(({ maxResults }) => {
    function clean(value) {
      return (value || '').replace(/\s+/g, ' ').trim();
    }
    function permalink(node) {
      const links = [...node.querySelectorAll('a[href]')]
        .map((a) => a.href)
        .filter((href) => /facebook\.com\/groups\/|\/permalink\/|story_fbid=|multi_permalinks=/.test(href));
      return links[0]?.split('?')[0] || null;
    }
    const nodes = [...document.querySelectorAll('[role="article"], div[data-pagelet^="SearchResults"] div[role="article"]')];
    const results = [];
    const seen = new Set();
    for (const node of nodes) {
      const text = clean(node.innerText);
      if (!text || text.length < 20) continue;
      const url = permalink(node);
      const key = url || text.slice(0, 300);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ text, permalink: url });
      if (results.length >= maxResults) break;
    }
    return results;
  }, { maxResults });
}

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 700);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (process.env.FB_SEMANTIC_SEARCH_OPENROUTER_RETRIES) {
    config.openrouter ||= {};
    config.openrouter.retries = Number(process.env.FB_SEMANTIC_SEARCH_OPENROUTER_RETRIES);
  }
  if (process.env.FB_SEMANTIC_SEARCH_OPENROUTER_TIMEOUT_MS) {
    config.openrouter ||= {};
    config.openrouter.timeoutMs = Number(process.env.FB_SEMANTIC_SEARCH_OPENROUTER_TIMEOUT_MS);
  }
  const groups = (config.groups || []).filter((group) => group.enabled).slice(0, maxGroups);
  fs.mkdirSync(outputDir, { recursive: true });
  const summary = {
    startedAt: new Date().toISOString(),
    model: config.openrouter?.model || 'openai/gpt-oss-120b:free',
    searchTerms,
    groups: [],
    totals: {
      searches: 0,
      scraped: 0,
      unique: 0,
      relevant: 0,
      rejected: 0,
      errors: 0,
    },
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
      const groupResult = { id: group.id, name: group.name, url: normalizeGroupUrl(group), results: [], errors: [] };
      summary.groups.push(groupResult);
      const seen = new Set();
      for (const term of searchTerms) {
        summary.totals.searches += 1;
        const url = searchUrl(group, term);
        console.error(`search group="${group.name || group.id}" term="${term}"`);
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(3500);
          if (await isLoginRequired(page)) throw new Error(`Facebook login/checkpoint at ${page.url()}`);
          for (let i = 0; i < scrollsPerSearch; i += 1) {
            await page.mouse.wheel(0, 1800);
            await page.waitForTimeout(1200);
          }
          const scraped = await scrapeResults(page, maxResultsPerSearch);
          summary.totals.scraped += scraped.length;
          console.error(`search term="${term}" scraped=${scraped.length}`);
          for (const item of scraped) {
            const key = item.permalink || item.text.slice(0, 300);
            if (seen.has(key)) continue;
            seen.add(key);
            summary.totals.unique += 1;
            const result = {
              term,
              permalink: item.permalink,
              snippet: snippet(item.text),
            };
            try {
              result.semantic = await withTimeout(classifyWithOpenRouter({
                text: item.text,
                groupName: group.name || group.id,
                targetType: 'post',
                config,
              }), classifyTimeoutMs, 'semantic classification');
              if (result.semantic.relevant) summary.totals.relevant += 1;
              else summary.totals.rejected += 1;
            } catch (error) {
              summary.totals.errors += 1;
              result.error = error.message;
            }
            groupResult.results.push(result);
          }
        } catch (error) {
          summary.totals.errors += 1;
          groupResult.errors.push({ term, error: error.message });
        }
      }
    }
  } finally {
    await context.close();
  }

  summary.finishedAt = new Date().toISOString();
  const file = path.join(outputDir, `semantic-search-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({
    output: file,
    totals: summary.totals,
    groups: summary.groups.map((group) => ({
      name: group.name,
      results: group.results.length,
      relevant: group.results.filter((item) => item.semantic?.relevant).length,
      errors: group.errors,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
