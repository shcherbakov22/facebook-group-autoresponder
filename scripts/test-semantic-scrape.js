#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { classifyWithOpenRouter } = require('./openrouter-classifier.js');

const projectRoot = path.resolve(__dirname, '..');
const configPath = process.env.FB_BOT_CONFIG || path.join(projectRoot, 'config', 'config.json');
const outputDir = process.env.FB_SEMANTIC_TEST_DIR || path.join(projectRoot, 'state', 'semantic-tests');
const maxGroups = Number(process.env.FB_SEMANTIC_TEST_MAX_GROUPS || 10);
const maxPostsPerGroup = Number(process.env.FB_SEMANTIC_TEST_POSTS || 30);
const maxCommentsPerPost = Number(process.env.FB_SEMANTIC_TEST_COMMENTS || 8);
const scrollsPerGroup = Number(process.env.FB_SEMANTIC_TEST_SCROLLS || 5);
const includeComments = process.env.FB_SEMANTIC_TEST_COMMENTS_ENABLED === '1';
const expandText = process.env.FB_SEMANTIC_TEST_EXPAND_TEXT === '1';
const classifyNonPrefilterSample = Number(process.env.FB_SEMANTIC_TEST_NEGATIVE_SAMPLE || 8);

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function ruleMatches(rule, text) {
  const source = normalizeText(text);
  const queries = Array.isArray(rule.queries) ? rule.queries.filter(Boolean) : [];
  const regexes = Array.isArray(rule.regexes) ? rule.regexes.filter(Boolean) : [];
  const checks = [
    ...queries.map((query) => source.includes(normalizeText(query))),
    ...regexes.map((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(text || '');
      } catch {
        return false;
      }
    }),
  ];
  if (checks.length === 0) return false;
  return rule.match === 'all' ? checks.every(Boolean) : checks.some(Boolean);
}

function normalizeGroupUrl(group) {
  if (group.url) return group.url;
  if (String(group.id || '').startsWith('http')) return group.id;
  return `https://www.facebook.com/groups/${group.id}`;
}

async function isLoginRequired(page) {
  const url = page.url();
  if (/\/login|checkpoint|recover\/initiate|two_step/i.test(url)) return true;
  const loginControls = await page.locator('input[name="email"], input[name="pass"], form[action*="login"]').count().catch(() => 0);
  return loginControls > 0;
}

async function expandVisibleText(page) {
  const selectors = [
    'div[role="button"]:has-text("See more")',
    'span:has-text("See more")',
    'div[role="button"]:has-text("View more")',
    'span:has-text("View more")',
    'div[role="button"]:has-text("Ещё")',
    'span:has-text("Ещё")',
    'div[role="button"]:has-text("Ще")',
    'span:has-text("Ще")',
  ];
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 25); i += 1) {
      await page.locator(selector).nth(i).click({ timeout: 1000 }).catch(() => {});
    }
  }
}

async function expandVisibleComments(page) {
  const selectors = [
    'div[role="button"]:has-text("View more comments")',
    'span:has-text("View more comments")',
    'div[role="button"]:has-text("View previous comments")',
    'span:has-text("View previous comments")',
    'div[role="button"]:has-text("See more comments")',
    'span:has-text("See more comments")',
    'div[role="button"]:has-text("Ещё комментарии")',
    'span:has-text("Ещё комментарии")',
    'div[role="button"]:has-text("Показать предыдущие комментарии")',
    'span:has-text("Показать предыдущие комментарии")',
    'div[role="button"]:has-text("Більше коментарів")',
    'span:has-text("Більше коментарів")',
  ];
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 10); i += 1) {
      await page.locator(selector).nth(i).click({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(300).catch(() => {});
    }
  }
}

async function scrapePosts(page, group) {
  const groupUrl = normalizeGroupUrl(group);
  await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);
  if (await isLoginRequired(page)) throw new Error(`Facebook login/checkpoint while opening ${groupUrl}`);
  if (expandText) await expandVisibleText(page);
  for (let i = 0; i < scrollsPerGroup; i += 1) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1600);
    if (expandText) await expandVisibleText(page);
  }
  return page.evaluate(({ maxPosts }) => {
    function clean(value) {
      return (value || '').replace(/\s+/g, ' ').trim();
    }
    function permalink(node) {
      const links = [...node.querySelectorAll('a[href]')]
        .map((a) => a.href)
        .filter((href) => /facebook\.com\/groups\/|\/permalink\/|story_fbid=|multi_permalinks=/.test(href));
      return links[0]?.split('?')[0] || null;
    }
    const nodes = [...document.querySelectorAll('[role="article"]')];
    const posts = [];
    const seen = new Set();
    for (const node of nodes) {
      const text = clean(node.innerText);
      if (!text || text.length < 20) continue;
      const url = permalink(node);
      const key = url || text.slice(0, 240);
      if (seen.has(key)) continue;
      seen.add(key);
      posts.push({ type: 'post', text, permalink: url });
      if (posts.length >= maxPosts) break;
    }
    return posts;
  }, { maxPosts: maxPostsPerGroup });
}

async function scrapeComments(page, post) {
  if (!post.permalink) return [];
  await page.goto(post.permalink, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
  if (await isLoginRequired(page)) throw new Error(`Facebook login/checkpoint while opening ${post.permalink}`);
  await expandVisibleComments(page);
  await expandVisibleText(page);
  return page.evaluate(({ maxComments, postText }) => {
    function clean(value) {
      return (value || '').replace(/\s+/g, ' ').trim();
    }
    const normalizedPost = clean(postText).slice(0, 120);
    const nodes = [...document.querySelectorAll('[aria-label*="Comment by"], [aria-label*="comment by"], div[role="article"]')];
    const comments = [];
    const seen = new Set();
    for (const node of nodes) {
      const text = clean(node.innerText);
      if (!text || text.length < 10) continue;
      if (normalizedPost && text.includes(normalizedPost)) continue;
      if (/^(like|reply|share|comment|нравится|ответить|поделиться)$/i.test(text)) continue;
      const key = text.slice(0, 240);
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push({ type: 'comment', text, permalink: window.location.href });
      if (comments.length >= maxComments) break;
    }
    return comments;
  }, { maxComments: maxCommentsPerPost, postText: post.text });
}

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 600);
}

async function main() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const semanticRule = (config.rules || []).find((rule) => rule.id === 'child-behavior-complaint');
  if (!semanticRule) throw new Error('Missing rule id child-behavior-complaint');
  const groups = (config.groups || []).filter((group) => group.enabled).slice(0, maxGroups);
  fs.mkdirSync(outputDir, { recursive: true });

  const context = await chromium.launchPersistentContext(config.scraper?.userDataDir || path.join(projectRoot, 'state', 'browser-profile'), {
    headless: config.scraper?.headless !== false,
    viewport: { width: 1365, height: 900 },
    locale: 'en-US',
    timezoneId: 'Africa/Cairo',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const summary = {
    startedAt: new Date().toISOString(),
    model: config.openrouter?.model || 'openai/gpt-oss-120b:free',
    groups: [],
    totals: {
      posts: 0,
      comments: 0,
      prefilterHits: 0,
      llmRelevant: 0,
      llmRejected: 0,
      llmErrors: 0,
      negativeSamplesChecked: 0,
      negativeSamplesRejected: 0,
      negativeSamplesFalsePositive: 0,
    },
  };

  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(3000);
    for (const group of groups) {
      const groupResult = { id: group.id, name: group.name, url: normalizeGroupUrl(group), posts: 0, comments: 0, candidates: [], errors: [] };
      summary.groups.push(groupResult);
      console.error(`scraping group="${group.name || group.id}" url=${groupResult.url}`);
      try {
        const posts = await scrapePosts(page, group);
        console.error(`group="${group.name || group.id}" posts=${posts.length}`);
        groupResult.posts = posts.length;
        summary.totals.posts += posts.length;
        const targets = [...posts];
        if (includeComments) {
          for (const post of posts.slice(0, Math.ceil(maxPostsPerGroup / 2))) {
            try {
              const comments = await scrapeComments(page, post);
              console.error(`group="${group.name || group.id}" comments_for_post=${comments.length}`);
              groupResult.comments += comments.length;
              summary.totals.comments += comments.length;
              targets.push(...comments);
            } catch (error) {
              groupResult.errors.push({ scope: 'comments', permalink: post.permalink, error: error.message });
            }
          }
        }

        const negativePool = [];
        for (const target of targets) {
          const prefilter = ruleMatches(semanticRule, target.text);
          if (!prefilter) {
            negativePool.push(target);
            continue;
          }
          summary.totals.prefilterHits += 1;
          console.error(`prefilter hit group="${group.name || group.id}" type=${target.type}`);
          const item = {
            type: target.type,
            permalink: target.permalink,
            snippet: snippet(target.text),
            prefilter: true,
          };
          try {
            item.semantic = await classifyWithOpenRouter({
              text: target.text,
              groupName: group.name || group.id,
              targetType: target.type,
              config,
            });
            if (item.semantic.relevant) summary.totals.llmRelevant += 1;
            else summary.totals.llmRejected += 1;
          } catch (error) {
            summary.totals.llmErrors += 1;
            item.error = error.message;
          }
          groupResult.candidates.push(item);
        }

        for (const target of negativePool.slice(0, classifyNonPrefilterSample)) {
          summary.totals.negativeSamplesChecked += 1;
          try {
            const semantic = await classifyWithOpenRouter({
              text: target.text,
              groupName: group.name || group.id,
              targetType: target.type,
              config,
            });
            const item = {
              type: target.type,
              permalink: target.permalink,
              snippet: snippet(target.text),
              prefilter: false,
              semantic,
            };
            if (semantic.relevant) {
              summary.totals.negativeSamplesFalsePositive += 1;
              groupResult.candidates.push(item);
            } else {
              summary.totals.negativeSamplesRejected += 1;
            }
          } catch (error) {
            summary.totals.llmErrors += 1;
          }
        }
      } catch (error) {
        groupResult.errors.push({ scope: 'group', error: error.message });
      }
    }
  } finally {
    await context.close();
  }

  summary.finishedAt = new Date().toISOString();
  const file = path.join(outputDir, `semantic-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ output: file, totals: summary.totals, groups: summary.groups.map((group) => ({
    name: group.name,
    posts: group.posts,
    comments: group.comments,
    candidates: group.candidates.length,
    errors: group.errors,
  })) }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
