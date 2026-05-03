const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { classifyWithOpenRouter } = require('./openrouter-classifier.js');

const SEEN_BASELINE_VERSION = 3;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function artifactName(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
}

function normalizeGroupUrl(group) {
  if (group.url) return group.url;
  if (group.fixturePath) return `file://${path.resolve(group.fixturePath)}`;
  if (String(group.id || '').startsWith('http')) return group.id;
  return `https://www.facebook.com/groups/${group.id}`;
}

function groupFeedUrl(group, config) {
  const groupUrl = normalizeGroupUrl(group);
  if (group.fixturePath || /^file:/i.test(groupUrl) || config.scraper?.useChronologicalFeed === false) return groupUrl;
  const url = new URL(groupUrl);
  url.searchParams.set('sorting_setting', 'CHRONOLOGICAL');
  return url.toString();
}

function stableTargetId(group, target) {
  if (target.permalink_url) return target.permalink_url;
  const textHash = Buffer.from(`${target.created_time || ''}:${target.message || ''}`).toString('base64url').slice(0, 80);
  return `${group.id || group.url}:${textHash}`;
}

function seenTargetKey(group, targetId) {
  return `${group.id || group.url}:${targetId}`;
}

function withTimeout(promise, timeoutMs, label, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      if (onTimeout) await onTimeout().catch(() => {});
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(error) {
  if (error?.message) return error.message;
  if (error?.code) return String(error.code);
  if (error?.name) return String(error.name);
  return String(error || 'unknown error');
}

function isLikelyOwnChildProblemComment(text) {
  const source = String(text || '').toLowerCase();
  return [
    /\b(мой|моя|мо[её]|моего|моему|моим|у меня)\s+(сын|дочь|реб[её]нок|подросток|дочка|сыну|сына|дочери)\b/i,
    /\b(сын|дочь|реб[её]нок|подросток|дочка)\s+(у меня|мой|моя|мо[её])\b/i,
    /\b(мій|моя|моє|мого|моїй|у мене)\s+(син|донька|дитина|підліток)\b/i,
    /\b(син|донька|дитина|підліток)\s+(у мене|мій|моя|моє)\b/i,
  ].some((pattern) => pattern.test(source));
}

async function isLoginRequired(page) {
  const url = page.url();
  if (/^file:/i.test(url)) return false;
  if (/\/login|checkpoint|recover\/initiate/i.test(url)) return true;
  const loginControls = await page.locator('input[name="email"], input[name="pass"], form[action*="login"]').count().catch(() => 0);
  return loginControls > 0;
}

async function expandVisibleText(page) {
  const selectors = [
    'div[role="button"]:has-text("See more")',
    'span:has-text("See more")',
    'div[role="button"]:has-text("See original")',
    'span:has-text("See original")',
    'div[role="button"]:has-text("View more")',
    'span:has-text("View more")',
    'div[role="button"]:has-text("Ещё")',
    'span:has-text("Ещё")',
    'div[role="button"]:has-text("Показать ещё")',
    'span:has-text("Показать ещё")',
    'div[role="button"]:has-text("Ще")',
    'span:has-text("Ще")',
    'div[role="button"]:has-text("Показати більше")',
    'span:has-text("Показати більше")',
  ];
  for (let pass = 0; pass < 2; pass += 1) {
    let clicked = 0;
    for (const selector of selectors) {
      const count = await page.locator(selector).count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 20); i += 1) {
        const target = page.locator(selector).nth(i);
        if (!(await target.isVisible().catch(() => false))) continue;
        await target.scrollIntoViewIfNeeded().catch(() => {});
        await target.click({ timeout: 1000 }).then(() => { clicked += 1; }).catch(() => {});
        await page.waitForTimeout(150).catch(() => {});
      }
    }
    if (!clicked) break;
    await page.waitForTimeout(700).catch(() => {});
  }
}

async function scrapePosts(page, group, config) {
  const scraper = config.scraper || {};
  const scrolls = Number(scraper.scrollsPerGroup || 3);
  const waitMs = Number(scraper.waitAfterScrollMs || 1500);
  const maxPosts = Number(config.polling?.feedLimitPerGroup || 25);
  const groupUrl = groupFeedUrl(group, config);

  await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: Number(scraper.navigationTimeoutMs || 60000) });
  await page.waitForTimeout(Number(scraper.initialWaitMs || 3000));
  if (await isLoginRequired(page)) {
    throw new Error(`Facebook session is not logged in or is checkpointed while opening ${groupUrl}`);
  }
  if (scraper.expandText === true) await expandVisibleText(page);

  for (let i = 0; i < scrolls; i += 1) {
    await page.mouse.wheel(0, Number(scraper.scrollPixels || 1800));
    await page.waitForTimeout(waitMs);
    if (scraper.expandText === true) await expandVisibleText(page);
  }

  return page.evaluate(({ maxPosts: limit }) => {
    function textOf(element) {
      return (element?.innerText || '').replace(/\s+/g, ' ').trim();
    }

    function canonicalFacebookUrl(href) {
      try {
        const url = new URL(href);
        const path = url.pathname;
        if (!/facebook\.com$/i.test(url.hostname) && !/\.facebook\.com$/i.test(url.hostname)) return null;
        if (/\/groups\/[^/]+\/user\//i.test(path)) return null;
        if (/\/groups\/[^/]+\/posts\/[^/]+/i.test(path) || /\/groups\/[^/]+\/permalink\/[^/]+/i.test(path)) {
          return new URL(`${url.origin}${path}`).toString();
        }
        if (url.searchParams.has('story_fbid') || url.searchParams.has('multi_permalinks')) {
          const clean = new URL(`${url.origin}${path}`);
          for (const key of ['story_fbid', 'multi_permalinks', 'id']) {
            if (url.searchParams.has(key)) clean.searchParams.set(key, url.searchParams.get(key));
          }
          return clean.toString();
        }
      } catch {
        return null;
      }
      return null;
    }

    function findPermalink(element) {
      const anchors = [...element.querySelectorAll('a[href]')];
      const candidates = anchors.map((anchor) => canonicalFacebookUrl(anchor.href)).filter(Boolean);
      return candidates[0] || null;
    }

    const articleNodes = [...document.querySelectorAll('[role="article"]')];
    const fallbackNodes = articleNodes.length > 0
      ? articleNodes
      : [...document.querySelectorAll('div[data-pagelet^="FeedUnit"], div[data-ad-preview="message"]')];

    const posts = [];
    const seen = new Set();
    for (const node of fallbackNodes) {
      const message = textOf(node);
      if (!message || message.length < 8) continue;
      const permalink = findPermalink(node);
      const key = permalink || message.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      posts.push({
        id: permalink || key,
        message,
        created_time: new Date().toISOString(),
        permalink_url: permalink
      });
      if (posts.length >= limit) break;
    }
    return posts;
  }, { maxPosts });
}

async function expandVisibleComments(page) {
  const selectors = [
    'div[role="button"]:has-text("View more comments")',
    'span:has-text("View more comments")',
    'div[role="button"]:has-text("View previous comments")',
    'span:has-text("View previous comments")',
    'div[role="button"]:has-text("See more comments")',
    'span:has-text("See more comments")',
  ];
  for (const selector of selectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 10); i += 1) {
      await page.locator(selector).nth(i).click({ timeout: 1000 }).catch(() => {});
      await page.waitForTimeout(300).catch(() => {});
    }
  }
}

async function scrapeCommentsForPost(page, post, config) {
  if (!post.permalink_url) return [];
  const scraper = config.scraper || {};
  const maxComments = Number(config.polling?.commentLimitPerPost || 25);
  await page.goto(post.permalink_url, { waitUntil: 'domcontentloaded', timeout: Number(scraper.navigationTimeoutMs || 60000) });
  await page.waitForTimeout(Number(scraper.initialWaitMs || 2500));
  if (await isLoginRequired(page)) {
    throw new Error(`Facebook session is not logged in or is checkpointed while opening ${post.permalink_url}`);
  }
  await expandVisibleComments(page);
  await expandVisibleText(page);

  return page.evaluate(({ maxComments: limit, postText }) => {
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

    function commentPermalink(node) {
      const links = [...node.querySelectorAll('a[href]')]
        .map((anchor) => canonicalFacebookUrl(anchor.href))
        .filter(Boolean);
      return links.find((href) => /[?&](comment_id|reply_comment_id)=/.test(href)) || links[0] || null;
    }

    const parentUrl = canonicalFacebookUrl(window.location.href) || window.location.href;
    const nodes = [
      ...document.querySelectorAll('[aria-label*="Comment by"], [aria-label*="comment by"], div[role="article"]')
    ];
    const comments = [];
    const seen = new Set();
    const normalizedPost = clean(postText).slice(0, 120);

    for (const node of nodes) {
      const text = clean(node.innerText);
      if (!text || text.length < 3) continue;
      if (normalizedPost && text.includes(normalizedPost)) continue;
      if (/^(like|reply|share|comment)$/i.test(text)) continue;
      const permalink = commentPermalink(node);
      const key = permalink || text.slice(0, 200);
      const existingIndex = comments.findIndex((comment) => (comment.permalink_url || comment.message.slice(0, 200)) === key);
      if (existingIndex >= 0) {
        if (text.length > comments[existingIndex].message.length) comments[existingIndex].message = text;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push({
        id: key,
        message: text,
        created_time: new Date().toISOString(),
        permalink_url: permalink,
        parent_permalink_url: parentUrl
      });
      if (comments.length >= limit) break;
    }
    return comments;
  }, { maxComments, postText: post.message || '' });
}

async function openTargetForReply(page, target, config) {
  const url = target.permalink_url || target.parent_permalink_url;
  if (!url) return false;
  const scraper = config.scraper || {};
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(scraper.navigationTimeoutMs || 60000) });
  await page.waitForTimeout(Number(scraper.initialWaitMs || 2500));
  return !(await isLoginRequired(page));
}

async function submitComment(page, response) {
  const commentButton = page.locator('div[role="button"]:has-text("Comment"), span:has-text("Comment")').first();
  await commentButton.click({ timeout: 4000 }).catch(() => {});

  const selectors = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea[name="comment_text"]',
    'textarea',
  ];

  for (const selector of selectors) {
    const input = page.locator(selector).last();
    if ((await input.count().catch(() => 0)) === 0) continue;
    try {
      await input.click({ timeout: 3000 });
      await input.fill(response, { timeout: 3000 }).catch(async () => {
        await page.keyboard.insertText(response);
      });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      return true;
    } catch {
      // Try the next selector.
    }
  }
  return false;
}

async function captureFailureArtifact(page, config, error) {
  const dir = config.scraper?.artifactDir || path.join(path.resolve(__dirname, '..'), 'state', 'artifacts');
  ensureDir(dir);
  const base = path.join(dir, artifactName('scrape-error'));
  await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
  const html = await page.content().catch(() => '');
  if (html) fs.writeFileSync(`${base}.html`, html);
  return {
    error: error.message,
    url: page.url(),
    screenshot: fs.existsSync(`${base}.png`) ? `${base}.png` : null,
    html: fs.existsSync(`${base}.html`) ? `${base}.html` : null
  };
}

async function pollWithScraper({ config, state, ruleMatches, canReply, markReplied, queueApproval }) {
  const scraper = config.scraper || {};
  const userDataDir = scraper.userDataDir || path.join(path.resolve(__dirname, '..'), 'state', 'browser-profile');
  ensureDir(userDataDir);

  const enabledGroups = (config.groups || []).filter((group) => group.enabled && (group.id || group.url));
  const enabledRules = (config.rules || []).filter((rule) => rule.enabled && rule.response);
  const maxReplies = Number(config.safety?.maxRepliesPerRun || 5);
  state.seen = state.seen && typeof state.seen === 'object' ? state.seen : {};
  const onlyNewTargets = Boolean(config.polling?.onlyNewTargets);
  const baselineOnFirstRun = Boolean(config.polling?.baselineSeenOnFirstRun);
  const baselineOnly = onlyNewTargets
    && baselineOnFirstRun
    && state.seen.__baselineVersion !== SEEN_BASELINE_VERSION;
  const stats = {
    mode: 'scraper',
    groups: enabledGroups.length,
    scanned: 0,
    newTargets: 0,
    seenRecorded: 0,
    baselineOnly,
    matched: 0,
    replies: [],
    skipped: [],
    artifacts: [],
    semanticChecked: 0,
    semanticMatched: 0,
  };
  const seenTargets = new Set();

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: scraper.headless !== false,
    viewport: { width: Number(scraper.width || 1365), height: Number(scraper.height || 900) },
    locale: scraper.locale || 'en-US',
    timezoneId: scraper.timezoneId || 'Africa/Cairo',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    for (const group of enabledGroups) {
      const page = await context.newPage();
      page.setDefaultTimeout(Number(scraper.defaultTimeoutMs || 10000));
      try {
        const posts = await withTimeout(
          scrapePosts(page, group, config),
          Number(scraper.groupTimeoutMs || 180000),
          `group scrape ${group.name || group.id || group.url}`,
          async () => page.close()
        );

        for (const post of posts) {
          const targets = [{ type: 'post', data: post }];
          if (config.polling?.includeComments) {
            const comments = await withTimeout(
              scrapeCommentsForPost(page, post, config),
              Number(scraper.commentTimeoutMs || 45000),
              `comment scrape ${post.permalink_url || post.id}`,
              async () => page.close()
            );
            for (const comment of comments) {
              targets.push({ type: 'comment', data: comment });
            }
          }

          for (const target of targets) {
            const targetId = stableTargetId(group, target.data);
            target.data.id = targetId;
            if (seenTargets.has(targetId)) continue;
            seenTargets.add(targetId);
            stats.scanned += 1;
            const targetSeenKey = seenTargetKey(group, targetId);
            const wasSeen = Boolean(state.seen[targetSeenKey]);
            if (!wasSeen) {
              state.seen[targetSeenKey] = new Date().toISOString();
              stats.seenRecorded += 1;
            }
            if (onlyNewTargets) {
              if (baselineOnly) {
                stats.skipped.push({ groupId: group.id || group.url, targetId, reason: 'baseline-seen' });
                continue;
              }
              if (wasSeen) {
                stats.skipped.push({ groupId: group.id || group.url, targetId, reason: 'already-seen' });
                continue;
              }
              stats.newTargets += 1;
            }
            for (const rule of enabledRules) {
              if (stats.replies.length >= maxReplies) break;
              if (!ruleMatches(rule, target.data.message || '')) continue;
              if (target.type === 'comment' && rule.semantic && !isLikelyOwnChildProblemComment(target.data.message || '')) {
                stats.skipped.push({
                  groupId: group.id || group.url,
                  targetId,
                  ruleId: rule.id,
                  reason: 'comment-not-own-child-problem',
                });
                continue;
              }

              const allowed = canReply(state, group.id || group.url, rule, targetId, config);
              if (!allowed.ok) {
                stats.skipped.push({ groupId: group.id || group.url, targetId, ruleId: rule.id, reason: allowed.reason });
                continue;
              }

              let semantic = null;
              if (rule.semantic) {
                stats.semanticChecked += 1;
                try {
                  semantic = await classifyWithOpenRouter({
                    text: target.data.message || '',
                    groupName: group.name || group.id || group.url,
                    targetType: target.type,
                    config,
                  });
                } catch (error) {
                  stats.skipped.push({
                    groupId: group.id || group.url,
                    targetId,
                    ruleId: rule.id,
                    reason: `semantic-error: ${errorMessage(error)}`,
                  });
                  continue;
                }
                const threshold = Number(rule.semanticThreshold || config.semanticClassifier?.threshold || 0.75);
                if (!semantic.relevant || semantic.confidence < threshold) {
                  stats.skipped.push({
                    groupId: group.id || group.url,
                    targetId,
                    ruleId: rule.id,
                    reason: 'semantic-not-relevant',
                    semantic,
                  });
                  continue;
                }
                stats.semanticMatched += 1;
              }
              stats.matched += 1;

              const action = {
                groupId: group.id || group.url,
                groupName: group.name || group.id || group.url,
                targetId,
                targetType: target.type,
                ruleId: rule.id,
                response: rule.response,
                targetText: String(target.data.message || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
                createdTime: target.data.created_time || null,
                dryRun: Boolean(config.dryRun),
                permalink: target.data.permalink_url || target.data.parent_permalink_url || null,
                semantic,
              };

              if (config.approvalMode) {
                queueApproval(state, action);
                markReplied(state, group.id || group.url, rule, targetId);
                stats.approvalsQueued = (stats.approvalsQueued || 0) + 1;
                stats.replies.push({ ...action, approvalQueued: true });
                continue;
              }

              if (!config.dryRun) {
                const opened = await openTargetForReply(page, target.data, config);
                if (!opened) {
                  stats.skipped.push({ groupId: action.groupId, targetId, ruleId: rule.id, reason: 'target-not-openable' });
                  continue;
                }
                const posted = await submitComment(page, rule.response);
                if (!posted) {
                  stats.skipped.push({ groupId: action.groupId, targetId, ruleId: rule.id, reason: 'comment-box-not-found' });
                  continue;
                }
              }

              markReplied(state, group.id || group.url, rule, targetId);
              stats.replies.push(action);
            }
          }
        }
      } catch (error) {
        stats.skipped.push({ groupId: group.id || group.url, reason: errorMessage(error) });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    if (baselineOnly) {
      state.seen.__baselineInitialized = true;
      state.seen.__baselineVersion = SEEN_BASELINE_VERSION;
      state.seen.__baselineAt = new Date().toISOString();
    }
    await context.close();
  }

  return stats;
}

module.exports = { pollWithScraper };
