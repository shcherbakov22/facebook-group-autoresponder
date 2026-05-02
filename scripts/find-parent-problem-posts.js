#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { classifyWithOpenRouter } = require('./openrouter-classifier.js');

const projectRoot = path.resolve(__dirname, '..');
const configPath = process.env.FB_BOT_CONFIG || path.join(projectRoot, 'config', 'config.json');
const outputDir = process.env.FB_PARENT_FIND_DIR || path.join(projectRoot, 'state', 'parent-finds');
const targetRelevant = Number(process.env.FB_PARENT_FIND_TARGET || 5);
const maxScrollsPerGroup = Number(process.env.FB_PARENT_FIND_SCROLLS || 80);
const maxCandidates = Number(process.env.FB_PARENT_FIND_MAX_CANDIDATES || 40);
const waitMs = Number(process.env.FB_PARENT_FIND_WAIT_MS || 1400);
const candidateTimeoutMs = Number(process.env.FB_PARENT_FIND_CANDIDATE_TIMEOUT_MS || 90000);
const expandCandidates = process.env.FB_PARENT_FIND_EXPAND !== 'false';

function normalizeGroupUrl(group) {
  if (group.url) return group.url.replace(/\/$/, '');
  if (String(group.id || '').startsWith('http')) return String(group.id).replace(/\/$/, '');
  return `https://www.facebook.com/groups/${group.id}`;
}

function chronologicalUrl(group) {
  return `${normalizeGroupUrl(group)}?sorting_setting=CHRONOLOGICAL`;
}

async function isLoginRequired(page) {
  const url = page.url();
  if (/\/login|checkpoint|recover\/initiate|two_step/i.test(url)) return true;
  const loginControls = await page.locator('input[name="email"], input[name="pass"], form[action*="login"]').count().catch(() => 0);
  return loginControls > 0;
}

function hasChildProblemTerms(text) {
  return /#child|реб[её]нок|подрост|сын|дочь|дитина|підліт|син|доньк|урок|школ|телефон|мотивац|агресс|агрес|істер|истер|не хочет|не хоче|ничего|нічого|child|teen|11-year|12-year|13-year|14-year|15-year|school|lesson|homework|martial arts/i.test(text || '');
}

async function extractVisibleCards(page, group) {
  return page.evaluate(({ groupUrl }) => {
    function clean(value) {
      return (value || '').replace(/\s+/g, ' ').trim();
    }
    function canonicalFacebookUrl(href) {
      try {
        const url = new URL(href);
        const path = url.pathname;
        if (!/facebook\.com$/i.test(url.hostname) && !/\.facebook\.com$/i.test(url.hostname)) return null;
        if (/\/groups\/[^/]+\/user\//i.test(path)) return null;
        if (/\/groups\/[^/]+\/posts\/[^/]+/i.test(path) || /\/groups\/[^/]+\/permalink\/[^/]+/i.test(path)) {
          const cleanUrl = new URL(`${url.origin}${path}`);
          for (const key of ['comment_id', 'reply_comment_id']) {
            if (url.searchParams.has(key)) cleanUrl.searchParams.set(key, url.searchParams.get(key));
          }
          return cleanUrl.toString();
        }
        if (url.searchParams.has('story_fbid') || url.searchParams.has('multi_permalinks')) {
          const cleanUrl = new URL(`${url.origin}${path}`);
          for (const key of ['story_fbid', 'multi_permalinks', 'id', 'comment_id', 'reply_comment_id']) {
            if (url.searchParams.has(key)) cleanUrl.searchParams.set(key, url.searchParams.get(key));
          }
          return cleanUrl.toString();
        }
      } catch {
        return null;
      }
      return null;
    }
    function postIdFrom(text) {
      const match = text.match(/groups\/[^/]+\/posts\/(\d+)/);
      return match?.[1] || null;
    }
    function permalinkFromNode(node) {
      const hit = nodeLinks(node)[0];
      if (!hit) return null;
      const id = postIdFrom(hit);
      return id ? `${groupUrl}/posts/${id}/` : hit;
    }
    function candidateLinksFromTextWindow(windowText) {
      const links = [];
      for (const match of windowText.matchAll(/https:\/\/www\.facebook\.com\/groups\/[^ "'<>]+/g)) {
        const href = canonicalFacebookUrl(match[0].replace(/[),.]+$/, ''));
        if (href) links.push(href);
      }
      return [...new Set(links)].slice(0, 10);
    }
    function nodeLinks(node) {
      return [...new Set([...node.querySelectorAll('a[href]')]
        .map((a) => a.href)
        .map((href) => canonicalFacebookUrl(href))
        .filter(Boolean))].slice(0, 10);
    }
    function findNodeForText(text) {
      const anchor = text.slice(0, 140);
      if (anchor.length < 40) return null;
      const nodes = [...document.querySelectorAll('[role="article"], div[data-pagelet^="FeedUnit"], div[data-ad-preview="message"]')];
      const matches = nodes
        .filter((node) => clean(node.innerText || '').includes(anchor))
        .sort((a, b) => clean(a.innerText || '').length - clean(b.innerText || '').length);
      return matches[0] || null;
    }

    const cards = [];
    const seen = new Set();
    const bodyText = clean(document.body.innerText);
    const bodyPattern = /(Facebook\s+){5,}(.+?)(All reactions:|Like Comment Share|Like Share|View more answers|Write an answer…)/g;
    for (const match of bodyText.matchAll(bodyPattern)) {
      const text = clean(match[2]);
      if (text.length < 80) continue;
      const windowText = bodyText.slice(Math.max(0, match.index - 4000), match.index + match[0].length + 4000);
      const id = postIdFrom(windowText);
      const nearbyNode = findNodeForText(text);
      const links = [...new Set([
        ...candidateLinksFromTextWindow(windowText),
        ...(nearbyNode ? nodeLinks(nearbyNode) : []),
      ])].slice(0, 10);
      const key = id || text.slice(0, 300);
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({
        source: 'body-feed-card',
        permalink: id ? `${groupUrl}/posts/${id}/` : null,
        candidateLinks: links,
        text,
      });
    }

    for (const node of [...document.querySelectorAll('[role="article"]')]) {
      const text = clean(node.innerText);
      if (text.length < 60) continue;
      const permalink = permalinkFromNode(node);
      const links = nodeLinks(node);
      const key = permalink || text.slice(0, 300);
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({ source: 'article', permalink, candidateLinks: links, text });
    }
    return cards;
  }, { groupUrl: normalizeGroupUrl(group) });
}

async function clickVisibleExpands(page) {
  for (let pass = 0; pass < 2; pass += 1) {
    let clicked = 0;
    for (const selector of [
      'div[role="button"]:has-text("See more")',
      'span:has-text("See more")',
      'div[role="button"]:has-text("See original")',
      'span:has-text("See original")',
      'div[role="button"]:has-text("Ещё")',
      'span:has-text("Ещё")',
      'div[role="button"]:has-text("Показать ещё")',
      'span:has-text("Показать ещё")',
      'div[role="button"]:has-text("Ще")',
      'span:has-text("Ще")',
      'div[role="button"]:has-text("Показати більше")',
      'span:has-text("Показати більше")',
    ]) {
      const count = await page.locator(selector).count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 20); i += 1) {
        const target = page.locator(selector).nth(i);
        if (!(await target.isVisible().catch(() => false))) continue;
        await target.scrollIntoViewIfNeeded().catch(() => {});
        await target.click({ timeout: 800 }).then(() => { clicked += 1; }).catch(() => {});
        await page.waitForTimeout(120);
      }
    }
    if (!clicked) break;
    await page.waitForTimeout(500);
  }
}

async function expandAndReadCandidate(page, card) {
  const links = [...new Set([card.permalink, ...(card.candidateLinks || [])].filter(Boolean))];
  if (!links.length) return card;

  function anchorsFor(text) {
    const cleaned = String(text || '')
      .replace(/Facebook/g, ' ')
      .replace(/See more|See original|See translation|Rate this translation/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const beforeEllipsis = cleaned.split('…')[0];
    return [...new Set([
      beforeEllipsis,
      ...beforeEllipsis.split(/[.!?。！？\n]/),
      ...beforeEllipsis.match(/.{40,160}/g) || [],
    ].map((value) => value.trim()).filter((value) => value.length >= 35))]
      .sort((a, b) => b.length - a.length)
      .slice(0, 12);
  }

  for (const link of links) {
    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3500);
      for (let pass = 0; pass < 3; pass += 1) {
        let clicked = 0;
        for (const selector of [
          'div[role="button"]:has-text("See more")',
          'span:has-text("See more")',
          'div[role="button"]:has-text("See original")',
          'span:has-text("See original")',
          'div[role="button"]:has-text("Ещё")',
          'span:has-text("Ещё")',
          'div[role="button"]:has-text("Показать ещё")',
          'span:has-text("Показать ещё")',
          'div[role="button"]:has-text("Ще")',
          'span:has-text("Ще")',
          'div[role="button"]:has-text("Показати більше")',
          'span:has-text("Показати більше")',
        ]) {
          const count = await page.locator(selector).count().catch(() => 0);
          for (let i = 0; i < Math.min(count, 12); i += 1) {
            const target = page.locator(selector).nth(i);
            if (!(await target.isVisible().catch(() => false))) continue;
            await target.scrollIntoViewIfNeeded().catch(() => {});
            await target.click({ timeout: 1000 }).then(() => { clicked += 1; }).catch(() => {});
            await page.waitForTimeout(200);
          }
        }
        if (!clicked) break;
        await page.waitForTimeout(900);
      }
      await page.waitForTimeout(1000);
      const full = await page.evaluate(({ cardText, anchorCandidates }) => {
        function clean(value) {
          return (value || '').replace(/\s+/g, ' ').trim();
        }
        const body = clean(document.body.innerText);
        const startMarkers = [...anchorCandidates, 'Anonymous participant', 'TurquoisePeacock7902', 'White_lily', 'Анна Ціпура', 'Anna LyRu'];
        let start = -1;
        for (const marker of startMarkers) {
          const idx = body.indexOf(marker);
          if (idx >= 0 && (start < 0 || idx < start)) start = idx;
        }
        if (start < 0) start = 0;
        const authorWindowStart = Math.max(0, start - 180);
        const authorWindow = body.slice(authorWindowStart, start);
        const authorCut = Math.max(
          authorWindow.lastIndexOf('Anonymous participant'),
          authorWindow.lastIndexOf(' · '),
        );
        if (authorCut >= 0 && start - (authorWindowStart + authorCut) < 120) {
          start = authorWindowStart + authorCut;
        }
        const after = body.slice(start);
        const endMarkers = ['All reactions:', 'Like Comment Share', 'Like Share', 'All comments', 'View more answers', 'Write an answer…', 'Write a comment…'];
        let end = after.length;
        for (const marker of endMarkers) {
          const idx = after.indexOf(marker);
          if (idx > 100 && idx < end) end = idx;
        }
        const extracted = after.slice(0, end).trim();
        return extracted.length > cardText.length ? extracted : '';
      }, { cardText: card.text, anchorCandidates: anchorsFor(card.text) });
      if (full && full.length > card.text.length) {
        return { ...card, permalink: link, text: full, expandedFromLink: true };
      }
    } catch {
      // Try next link.
    }
  }
  return card;
}

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 1000);
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
  if (process.env.FB_PARENT_FIND_OPENROUTER_RETRIES) {
    config.openrouter ||= {};
    config.openrouter.retries = Number(process.env.FB_PARENT_FIND_OPENROUTER_RETRIES);
  }
  if (process.env.FB_PARENT_FIND_OPENROUTER_TIMEOUT_MS) {
    config.openrouter ||= {};
    config.openrouter.timeoutMs = Number(process.env.FB_PARENT_FIND_OPENROUTER_TIMEOUT_MS);
  }
  const groups = (config.groups || []).filter((group) => group.enabled);
  fs.mkdirSync(outputDir, { recursive: true });

  const report = {
    startedAt: new Date().toISOString(),
    targetRelevant,
    groups: [],
    relevant: [],
    rejected: [],
    errors: [],
  };

  const context = await chromium.launchPersistentContext(config.scraper?.userDataDir || path.join(projectRoot, 'state', 'browser-profile'), {
    headless: config.scraper?.headless !== false,
    viewport: { width: 1365, height: 1000 },
    locale: 'en-US',
    timezoneId: 'Africa/Cairo',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const globalSeen = new Set();
  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(4000);

    for (const group of groups) {
      if (report.relevant.length >= targetRelevant) break;
      const groupResult = { name: group.name, url: chronologicalUrl(group), scrolls: 0, cards: 0, candidates: 0, relevant: 0, errors: [] };
      report.groups.push(groupResult);
      console.error(`finding group="${group.name || group.id}"`);
      try {
        await page.goto(chronologicalUrl(group), { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4500);
        if (await isLoginRequired(page)) throw new Error(`Facebook login/checkpoint at ${page.url()}`);

        for (let scroll = 0; scroll <= maxScrollsPerGroup; scroll += 1) {
          groupResult.scrolls = scroll;
          await clickVisibleExpands(page);
          const cards = await extractVisibleCards(page, group);
          groupResult.cards = Math.max(groupResult.cards, cards.length);

          for (const card of cards) {
            if (!hasChildProblemTerms(card.text)) continue;
            const key = card.permalink || card.text.slice(0, 300);
            if (globalSeen.has(key)) continue;
            globalSeen.add(key);
            groupResult.candidates += 1;
            console.error(`candidate group="${group.name || group.id}" source=${card.source} permalink=${card.permalink || 'none'}`);
            let expandedCard;
            try {
              expandedCard = expandCandidates
                ? await withTimeout(expandAndReadCandidate(page, card), candidateTimeoutMs, 'candidate expansion')
                : card;
            } catch (error) {
              const item = {
                group: group.name || group.id,
                source: card.source,
                permalink: card.permalink,
                candidateLinks: card.candidateLinks || [],
                fullText: card.text,
                snippet: snippet(card.text),
                error: error.message,
              };
              report.errors.push(item);
              console.error(`candidate expansion error: ${error.message}`);
              continue;
            }
            const item = {
              group: group.name || group.id,
              source: expandedCard.source,
              permalink: expandedCard.permalink,
              candidateLinks: expandedCard.candidateLinks || [],
              expandedFromLink: Boolean(expandedCard.expandedFromLink),
              fullText: expandedCard.text,
              snippet: snippet(expandedCard.text),
            };
            try {
              item.semantic = await withTimeout(classifyWithOpenRouter({
                text: expandedCard.text,
                groupName: group.name || group.id,
                targetType: 'post',
                config,
              }), candidateTimeoutMs, 'semantic classification');
              if (item.semantic.relevant) {
                groupResult.relevant += 1;
                report.relevant.push(item);
                console.error(`RELEVANT confidence=${item.semantic.confidence} reason=${item.semantic.reason}`);
                if (report.relevant.length >= targetRelevant) break;
              } else {
                report.rejected.push(item);
              }
            } catch (error) {
              item.error = error.message;
              report.errors.push(item);
            }
            if (globalSeen.size >= maxCandidates && report.relevant.length === 0) {
              console.error('candidate cap hit without relevant matches');
              break;
            }
          }

          if (report.relevant.length >= targetRelevant || globalSeen.size >= maxCandidates) break;
          await page.mouse.wheel(0, 1800);
          await page.waitForTimeout(waitMs);
        }
      } catch (error) {
        groupResult.errors.push(error.message);
      }
    }
  } finally {
    await context.close();
  }

  report.finishedAt = new Date().toISOString();
  const file = path.join(outputDir, `parent-finds-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: file,
    relevant: report.relevant.length,
    rejected: report.rejected.length,
    errors: report.errors.length,
    groups: report.groups,
    relevantSnippets: report.relevant.map((item) => ({
      group: item.group,
      confidence: item.semantic?.confidence,
      category: item.semantic?.category,
      reason: item.semantic?.reason,
      permalink: item.permalink,
      snippet: item.snippet.slice(0, 700),
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
