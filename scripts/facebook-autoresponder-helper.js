#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { pollWithScraper } = require('./facebook-scraper-engine.js');

const projectRoot = path.resolve(__dirname, '..');
const configPath = process.env.FB_BOT_CONFIG || path.join(projectRoot, 'config', 'config.json');
const statePath = process.env.FB_BOT_STATE || path.join(projectRoot, 'state', 'state.json');
const historyPath = process.env.FB_BOT_HISTORY || path.join(projectRoot, 'state', 'history.jsonl');
const port = Number(process.env.FB_BOT_PORT || 4020);

function readJson(filePath, fallback) {
  try {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    if (!text) return fallback;
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function writeText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  const payload = Buffer.from(body);
  res.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': String(payload.length),
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function loadConfig() {
  const config = readJson(configPath, null);
  if (!config) {
    throw new Error(`Missing config at ${configPath}. Copy config.example.json to config.json first.`);
  }
  const errors = validateConfig(config);
  if (errors.length > 0) {
    const error = new Error(`Invalid config: ${errors.join('; ')}`);
    error.validationErrors = errors;
    throw error;
  }
  return config;
}

function loadState() {
  return readJson(statePath, {
    replied: {},
    cooldowns: {},
    seen: {},
    pendingApprovals: {},
    lastRunAt: null,
    lastError: null
  });
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function tailJsonl(filePath, limit = 20) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function textExcerpt(value, maxLength = 1200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function validateConfig(config) {
  const errors = [];
  if (!['scraper', 'graph', undefined].includes(config.mode)) {
    errors.push('mode must be "scraper" or "graph"');
  }
  if (typeof config.dryRun !== 'boolean') {
    errors.push('dryRun must be boolean');
  }
  const enabledGroups = (config.groups || []).filter((group) => group.enabled);
  for (const group of enabledGroups) {
    if (!group.id && !group.url && !group.fixturePath) {
      errors.push(`enabled group "${group.name || 'unnamed'}" needs id, url, or fixturePath`);
    }
  }
  const ruleIds = new Set();
  for (const rule of config.rules || []) {
    if (!rule.id) errors.push('each rule needs id');
    if (rule.id && ruleIds.has(rule.id)) errors.push(`duplicate rule id "${rule.id}"`);
    if (rule.id) ruleIds.add(rule.id);
    if (rule.enabled) {
      if (!rule.response) errors.push(`enabled rule "${rule.id}" needs response`);
      const queryCount = (rule.queries || []).filter(Boolean).length;
      const regexCount = (rule.regexes || []).filter(Boolean).length;
      if (queryCount + regexCount === 0) errors.push(`enabled rule "${rule.id}" needs queries or regexes`);
      for (const pattern of rule.regexes || []) {
        try {
          new RegExp(pattern);
        } catch {
          errors.push(`rule "${rule.id}" has invalid regex "${pattern}"`);
        }
      }
    }
  }
  const maxReplies = Number(config.safety?.maxRepliesPerRun ?? 5);
  if (!Number.isFinite(maxReplies) || maxReplies < 0) {
    errors.push('safety.maxRepliesPerRun must be a non-negative number');
  }
  return errors;
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function isRecent(createdTime, lookbackMinutes) {
  if (!createdTime) return false;
  const created = new Date(createdTime).getTime();
  if (!Number.isFinite(created)) return false;
  return created >= Date.now() - lookbackMinutes * 60 * 1000;
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
    })
  ];
  if (checks.length === 0) return false;
  return rule.match === 'all' ? checks.every(Boolean) : checks.some(Boolean);
}

function graphRequest(method, apiVersion, objectPath, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://graph.facebook.com/${apiVersion}/${objectPath.replace(/^\//, '')}`);
    if (method === 'GET') {
      url.searchParams.set('access_token', token);
    }
    const payload = body
      ? Buffer.from(new URLSearchParams({ ...body, access_token: token }).toString())
      : null;
    const req = https.request(url, {
      method,
      headers: payload
        ? {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': String(payload.length)
          }
        : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { raw: text };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }
        const error = new Error(`Graph ${method} ${url.pathname} failed ${res.statusCode}: ${text.slice(0, 500)}`);
        error.response = parsed;
        reject(error);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function listFeed(group, config, token) {
  const fields = 'id,message,created_time,permalink_url,from';
  const limit = config.polling?.feedLimitPerGroup || 25;
  const result = await graphRequest(
    'GET',
    config.facebook.apiVersion,
    `${group.id}/feed?fields=${encodeURIComponent(fields)}&limit=${encodeURIComponent(limit)}`,
    token
  );
  return Array.isArray(result.data) ? result.data : [];
}

async function listComments(postId, config, token) {
  const fields = 'id,message,created_time,from';
  const limit = config.polling?.commentLimitPerPost || 25;
  const result = await graphRequest(
    'GET',
    config.facebook.apiVersion,
    `${postId}/comments?fields=${encodeURIComponent(fields)}&limit=${encodeURIComponent(limit)}`,
    token
  );
  return Array.isArray(result.data) ? result.data : [];
}

function canReply(state, groupId, rule, targetId, config) {
  const replyKey = `${targetId}:${rule.id}`;
  if (state.replied[replyKey]) return { ok: false, reason: 'already-replied' };

  const now = Date.now();
  const groupCooldownKey = `${groupId}:${rule.id}`;
  const globalGap = Number(config.safety?.minMinutesBetweenRepliesPerGroup || 0) * 60 * 1000;
  const ruleGap = Number(rule.cooldownMinutes || 0) * 60 * 1000;
  const lastGroupReplyAt = state.cooldowns[groupCooldownKey] || 0;
  if (globalGap > 0 && now - lastGroupReplyAt < globalGap) {
    return { ok: false, reason: 'group-cooldown' };
  }
  const targetCooldownKey = `${targetId}:${rule.id}`;
  const lastTargetReplyAt = state.cooldowns[targetCooldownKey] || 0;
  if (ruleGap > 0 && now - lastTargetReplyAt < ruleGap) {
    return { ok: false, reason: 'rule-cooldown' };
  }
  return { ok: true };
}

function markReplied(state, groupId, rule, targetId) {
  const now = Date.now();
  state.replied[`${targetId}:${rule.id}`] = new Date(now).toISOString();
  state.cooldowns[`${groupId}:${rule.id}`] = now;
  state.cooldowns[`${targetId}:${rule.id}`] = now;
}

function queueApproval(state, action) {
  const key = `${action.targetId}:${action.ruleId}`;
  state.pendingApprovals ||= {};
  if (!state.pendingApprovals[key]) {
    state.pendingApprovals[key] = {
      ...action,
      queuedAt: new Date().toISOString(),
      status: 'pending'
    };
  }
}

async function maybeReply({ group, target, targetType, rule, config, token, state, stats }) {
  const allowed = canReply(state, group.id, rule, target.id, config);
  if (!allowed.ok) {
    stats.skipped.push({ groupId: group.id, targetId: target.id, ruleId: rule.id, reason: allowed.reason });
    return;
  }
  const action = {
    groupId: group.id,
    groupName: group.name || group.id,
    targetId: target.id,
    targetType,
    ruleId: rule.id,
    response: rule.response,
    targetText: textExcerpt(target.message || ''),
    createdTime: target.created_time || null,
    dryRun: Boolean(config.dryRun),
    permalink: target.permalink_url || null
  };
  if (config.approvalMode) {
    queueApproval(state, action);
    markReplied(state, group.id, rule, target.id);
    stats.approvalsQueued = (stats.approvalsQueued || 0) + 1;
    stats.replies.push({ ...action, approvalQueued: true });
    return;
  }
  if (!config.dryRun) {
    await graphRequest('POST', config.facebook.apiVersion, `${target.id}/comments`, token, { message: rule.response });
  }
  markReplied(state, group.id, rule, target.id);
  stats.replies.push(action);
}

async function pollOnce() {
  const config = loadConfig();
  const state = loadState();
  const startedAt = new Date().toISOString();
  if (config.mode === 'scraper') {
    const stats = await pollWithScraper({ config, state, ruleMatches, canReply, markReplied, queueApproval });
    state.lastRunAt = new Date().toISOString();
    state.lastError = null;
    writeJsonAtomic(statePath, state);
    const result = { ok: true, dryRun: Boolean(config.dryRun), approvalMode: Boolean(config.approvalMode), ...stats };
    appendJsonl(historyPath, { startedAt, finishedAt: state.lastRunAt, result });
    return result;
  }

  const tokenName = config.facebook?.accessTokenEnv || 'FB_PAGE_ACCESS_TOKEN';
  const token = process.env[tokenName] || config.facebook?.accessToken;
  if (!token) throw new Error(`Missing Facebook access token. Set ${tokenName} or config.facebook.accessToken.`);

  const enabledGroups = (config.groups || []).filter((group) => group.enabled && group.id);
  const enabledRules = (config.rules || []).filter((rule) => rule.enabled && rule.response);
  const lookbackMinutes = Number(config.polling?.lookbackMinutes || 30);
  const maxReplies = Number(config.safety?.maxRepliesPerRun || 5);
  const stats = { groups: enabledGroups.length, scanned: 0, matched: 0, replies: [], skipped: [] };

  for (const group of enabledGroups) {
    const posts = await listFeed(group, config, token);
    for (const post of posts) {
      if (!isRecent(post.created_time, lookbackMinutes)) continue;
      stats.scanned += 1;
      for (const rule of enabledRules) {
        if (stats.replies.length >= maxReplies) break;
        if (!ruleMatches(rule, post.message || '')) continue;
        stats.matched += 1;
        await maybeReply({ group, target: post, targetType: 'post', rule, config, token, state, stats });
      }
      if (config.polling?.includeComments && stats.replies.length < maxReplies) {
        const comments = await listComments(post.id, config, token);
        for (const comment of comments) {
          if (!isRecent(comment.created_time, lookbackMinutes)) continue;
          stats.scanned += 1;
          for (const rule of enabledRules) {
            if (stats.replies.length >= maxReplies) break;
            if (!ruleMatches(rule, comment.message || '')) continue;
            stats.matched += 1;
            await maybeReply({ group, target: comment, targetType: 'comment', rule, config, token, state, stats });
          }
        }
      }
    }
  }

  state.lastRunAt = new Date().toISOString();
  state.lastError = null;
  writeJsonAtomic(statePath, state);
  const result = { ok: true, dryRun: Boolean(config.dryRun), approvalMode: Boolean(config.approvalMode), ...stats };
  appendJsonl(historyPath, { startedAt, finishedAt: state.lastRunAt, result });
  return result;
}

function sendJson(res, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, configPath, statePath });
      return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      const config = loadConfig();
      const state = loadState();
      sendJson(res, 200, {
        ok: true,
        mode: config.mode || 'graph',
        dryRun: Boolean(config.dryRun),
        approvalMode: Boolean(config.approvalMode),
        enabledGroups: (config.groups || []).filter((group) => group.enabled).length,
        enabledRules: (config.rules || []).filter((rule) => rule.enabled).length,
        pendingApprovals: Object.values(state.pendingApprovals || {}).filter((item) => item.status === 'pending').length,
        repliedCount: Object.keys(state.replied || {}).length,
        lastRunAt: state.lastRunAt,
        lastError: state.lastError,
        configPath,
        statePath,
        historyPath
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      const limit = Number(url.searchParams.get('limit') || 20);
      sendJson(res, 200, { ok: true, history: tailJsonl(historyPath, Math.max(1, Math.min(limit, 200))) });
      return;
    }
    if (req.method === 'GET' && req.url === '/approvals') {
      const state = loadState();
      sendJson(res, 200, {
        ok: true,
        approvals: Object.entries(state.pendingApprovals || {}).map(([id, item]) => ({ id, ...item }))
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/approvals/skip') {
      const id = url.searchParams.get('id');
      if (!id) {
        sendJson(res, 400, { ok: false, error: 'missing id' });
        return;
      }
      const state = loadState();
      if (!state.pendingApprovals?.[id]) {
        sendJson(res, 404, { ok: false, error: 'approval not found' });
        return;
      }
      state.pendingApprovals[id].status = 'skipped';
      state.pendingApprovals[id].skippedAt = new Date().toISOString();
      writeJsonAtomic(statePath, state);
      appendJsonl(historyPath, { startedAt: null, finishedAt: state.pendingApprovals[id].skippedAt, result: { ok: true, action: 'approval-skipped', id } });
      sendJson(res, 200, { ok: true, approval: { id, ...state.pendingApprovals[id] } });
      return;
    }
    if (req.method === 'POST' && req.url === '/poll') {
      const result = await pollOnce();
      sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    const state = loadState();
    state.lastError = { at: new Date().toISOString(), message: error.message };
    writeJsonAtomic(statePath, state);
    appendJsonl(historyPath, { startedAt: null, finishedAt: state.lastError.at, result: { ok: false, error: error.message } });
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`facebook-autoresponder-helper listening on 127.0.0.1:${port}`);
});
