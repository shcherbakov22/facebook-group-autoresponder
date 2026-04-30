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

function dashboardData() {
  const config = loadConfig();
  const state = loadState();
  const history = tailJsonl(historyPath, 100).reverse();
  const pendingApprovals = Object.entries(state.pendingApprovals || {})
    .map(([id, item]) => ({ id, ...item }))
    .sort((left, right) => String(right.queuedAt || '').localeCompare(String(left.queuedAt || '')));

  const replyEvents = [];
  const skippedEvents = [];
  for (const entry of history) {
    const result = entry.result || {};
    for (const reply of result.replies || []) {
      replyEvents.push({
        runStartedAt: entry.startedAt,
        runFinishedAt: entry.finishedAt,
        ...reply,
      });
    }
    for (const skipped of result.skipped || []) {
      skippedEvents.push({
        runStartedAt: entry.startedAt,
        runFinishedAt: entry.finishedAt,
        ...skipped,
      });
    }
  }

  return {
    ok: true,
    now: new Date().toISOString(),
    status: {
      mode: config.mode || 'graph',
      dryRun: Boolean(config.dryRun),
      approvalMode: Boolean(config.approvalMode),
      enabledGroups: (config.groups || []).filter((group) => group.enabled).length,
      totalGroups: (config.groups || []).length,
      enabledRules: (config.rules || []).filter((rule) => rule.enabled).length,
      totalRules: (config.rules || []).length,
      pendingApprovals: pendingApprovals.filter((item) => item.status === 'pending').length,
      repliedCount: Object.keys(state.replied || {}).length,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
      configPath,
      statePath,
      historyPath,
    },
    groups: (config.groups || []).map((group) => ({
      id: group.id || group.url || group.name,
      name: group.name || group.id || group.url,
      url: group.url || null,
      enabled: Boolean(group.enabled),
    })),
    rules: (config.rules || []).map((rule) => ({
      id: rule.id,
      enabled: Boolean(rule.enabled),
      semantic: Boolean(rule.semantic),
      response: rule.response || '',
      cooldownMinutes: rule.cooldownMinutes || 0,
    })),
    approvals: pendingApprovals,
    replies: replyEvents.slice(0, 100),
    skipped: skippedEvents.slice(0, 100),
    history,
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Facebook Bot Control Panel</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #10130f;
      --panel: #181d15;
      --panel2: #20281b;
      --ink: #f2f0dc;
      --muted: #a9ad98;
      --line: #3c432f;
      --accent: #f2b84b;
      --bad: #ff7469;
      --good: #84d17d;
      --blue: #88b7ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(242, 184, 75, .16), transparent 32rem),
        linear-gradient(135deg, #0c100d, #171b12 48%, #111510);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      padding: 28px;
      border-bottom: 1px solid var(--line);
      background: rgba(16, 19, 15, .78);
      position: sticky;
      top: 0;
      backdrop-filter: blur(12px);
      z-index: 5;
    }
    h1 { margin: 0 0 8px; font-size: clamp(28px, 4vw, 48px); letter-spacing: -0.05em; }
    .sub { color: var(--muted); }
    main { padding: 24px; display: grid; gap: 18px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
    .card {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(32, 40, 27, .95), rgba(20, 24, 18, .95));
      padding: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,.22);
    }
    .metric { font-size: 30px; font-weight: 800; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .13em; }
    button, a.button {
      border: 1px solid #735f29;
      background: linear-gradient(180deg, #f3c55c, #b87b24);
      color: #151207;
      border-radius: 999px;
      padding: 10px 14px;
      font-weight: 800;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      gap: 8px;
      align-items: center;
    }
    button.secondary { background: #222a1c; color: var(--ink); border-color: var(--line); }
    button.danger { background: #5b2626; color: #ffe9e7; border-color: #8f3c38; }
    button:disabled { opacity: .55; cursor: wait; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; }
    .tab { background: #1a2116; color: var(--ink); border-color: var(--line); }
    .tab.active { background: #f2b84b; color: #151207; }
    .section { display: none; }
    .section.active { display: grid; gap: 12px; }
    .item { border: 1px solid var(--line); border-radius: 14px; background: rgba(12, 16, 13, .6); padding: 14px; display: grid; gap: 10px; }
    .meta { color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 8px; }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; }
    .good { color: var(--good); }
    .bad { color: var(--bad); }
    .blue { color: var(--blue); }
    pre, .text {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      line-height: 1.45;
    }
    .response { border-left: 3px solid var(--accent); padding-left: 10px; color: #ffe0a0; }
    .empty { color: var(--muted); padding: 18px; border: 1px dashed var(--line); border-radius: 14px; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 360px); gap: 18px; align-items: start; }
    @media (max-width: 900px) { .split { grid-template-columns: 1fr; } header, main { padding: 16px; } }
  </style>
</head>
<body>
  <header>
    <div class="row" style="justify-content: space-between;">
      <div>
        <h1>Facebook Bot Control</h1>
        <div class="sub" id="subtitle">Loading…</div>
      </div>
      <div class="row">
        <button id="pollBtn">Run Poll Now</button>
        <button class="secondary" id="refreshBtn">Refresh</button>
      </div>
    </div>
  </header>
  <main>
    <section class="grid" id="metrics"></section>
    <div class="tabs">
      <button class="tab active" data-tab="replies">Replies</button>
      <button class="tab" data-tab="approvals">Approvals</button>
      <button class="tab" data-tab="skipped">Skipped</button>
      <button class="tab" data-tab="rules">Rules / Groups</button>
      <button class="tab" data-tab="runs">Runs</button>
    </div>
    <div class="split">
      <section class="card section active" id="replies"></section>
      <section class="card section" id="approvals"></section>
      <section class="card section" id="skipped"></section>
      <section class="card section" id="rules"></section>
      <section class="card section" id="runs"></section>
      <aside class="card">
        <div class="label">Paths</div>
        <pre id="paths" style="margin-top:10px;color:var(--muted)"></pre>
      </aside>
    </div>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const fmt = (value) => value ? new Date(value).toLocaleString() : 'never';
    const short = (value, n = 1800) => {
      const text = String(value || '');
      return text.length > n ? text.slice(0, n - 1) + '…' : text;
    };
    let state = null;

    async function load() {
      const response = await fetch('/dashboard-data', { cache: 'no-store' });
      state = await response.json();
      render();
    }

    async function runPoll() {
      const btn = $('pollBtn');
      btn.disabled = true;
      btn.textContent = 'Polling…';
      try {
        const response = await fetch('/poll', { method: 'POST' });
        const data = await response.json();
        if (!data.ok) alert(data.error || 'Poll failed');
      } catch (error) {
        alert(error.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run Poll Now';
        await load();
      }
    }

    async function skipApproval(id) {
      if (!confirm('Mark this approval as skipped?')) return;
      await fetch('/approvals/skip?id=' + encodeURIComponent(id), { method: 'POST' });
      await load();
    }

    function renderMetrics(status) {
      const metrics = [
        ['Mode', status.mode],
        ['Dry Run', status.dryRun ? 'yes' : 'no'],
        ['Approval', status.approvalMode ? 'yes' : 'no'],
        ['Groups', status.enabledGroups + '/' + status.totalGroups],
        ['Rules', status.enabledRules + '/' + status.totalRules],
        ['Pending', status.pendingApprovals],
        ['Replied Keys', status.repliedCount],
        ['Last Run', status.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString() : 'never'],
      ];
      $('metrics').innerHTML = metrics.map(([label, value]) => '<div class="card"><div class="label">' + escapeHtml(label) + '</div><div class="metric">' + escapeHtml(value) + '</div></div>').join('');
    }

    function renderReplies(items) {
      $('replies').innerHTML = '<h2>Replies / Dry-run Matches</h2>' + (items.length ? items.map((item) => {
        const status = item.dryRun ? '<span class="pill blue">dry-run</span>' : '<span class="pill good">posted</span>';
        const approval = item.approvalQueued ? '<span class="pill">queued approval</span>' : '';
        return '<article class="item">'
          + '<div class="meta">' + status + approval + '<span class="pill">' + escapeHtml(item.groupName || item.groupId || '-') + '</span><span class="pill">' + escapeHtml(item.ruleId || '-') + '</span><span>' + escapeHtml(fmt(item.runFinishedAt)) + '</span></div>'
          + (item.permalink ? '<a class="button secondary" target="_blank" href="' + escapeHtml(item.permalink) + '">Open Facebook</a>' : '')
          + (item.targetText ? '<div><div class="label">Matched text</div><p class="text">' + escapeHtml(short(item.targetText)) + '</p></div>' : '<div class="empty">No text stored for this older event.</div>')
          + (item.semantic ? '<div class="meta"><span class="pill">confidence ' + escapeHtml(item.semantic.confidence) + '</span><span class="pill">' + escapeHtml(item.semantic.category || '-') + '</span><span>' + escapeHtml(item.semantic.reason || '') + '</span></div>' : '')
          + '<div><div class="label">Response</div><p class="text response">' + escapeHtml(item.response || '') + '</p></div>'
          + '</article>';
      }).join('') : '<div class="empty">No replies or dry-run matches in history yet.</div>');
    }

    function renderApprovals(items) {
      $('approvals').innerHTML = '<h2>Pending / Past Approvals</h2>' + (items.length ? items.map((item) => {
        return '<article class="item">'
          + '<div class="meta"><span class="pill">' + escapeHtml(item.status || 'pending') + '</span><span class="pill">' + escapeHtml(item.groupName || item.groupId || '-') + '</span><span class="pill">' + escapeHtml(item.ruleId || '-') + '</span><span>' + escapeHtml(fmt(item.queuedAt)) + '</span></div>'
          + (item.permalink ? '<a class="button secondary" target="_blank" href="' + escapeHtml(item.permalink) + '">Open Facebook</a>' : '')
          + (item.targetText ? '<div><div class="label">Matched text</div><p class="text">' + escapeHtml(short(item.targetText)) + '</p></div>' : '')
          + '<div><div class="label">Response</div><p class="text response">' + escapeHtml(item.response || '') + '</p></div>'
          + (item.status === 'pending' ? '<div class="row"><button class="danger" onclick="skipApproval(' + JSON.stringify(item.id).replace(/"/g, '&quot;') + ')">Skip</button></div>' : '')
          + '</article>';
      }).join('') : '<div class="empty">No approval queue entries.</div>');
    }

    function renderSkipped(items) {
      $('skipped').innerHTML = '<h2>Skipped</h2>' + (items.length ? items.map((item) => {
        return '<article class="item">'
          + '<div class="meta"><span class="pill bad">' + escapeHtml(item.reason || '-') + '</span><span class="pill">' + escapeHtml(item.groupId || '-') + '</span><span class="pill">' + escapeHtml(item.ruleId || '-') + '</span><span>' + escapeHtml(fmt(item.runFinishedAt)) + '</span></div>'
          + (item.semantic ? '<pre>' + escapeHtml(JSON.stringify(item.semantic, null, 2)) + '</pre>' : '')
          + '</article>';
      }).join('') : '<div class="empty">No skipped items in recent history.</div>');
    }

    function renderRules(data) {
      $('rules').innerHTML = '<h2>Rules</h2>' + data.rules.map((rule) =>
        '<article class="item"><div class="meta"><span class="pill ' + (rule.enabled ? 'good' : 'bad') + '">' + (rule.enabled ? 'enabled' : 'disabled') + '</span><span class="pill">' + escapeHtml(rule.id) + '</span><span class="pill">semantic ' + (rule.semantic ? 'yes' : 'no') + '</span></div><p class="text response">' + escapeHtml(rule.response) + '</p></article>'
      ).join('') + '<h2>Groups</h2>' + data.groups.map((group) =>
        '<article class="item"><div class="meta"><span class="pill ' + (group.enabled ? 'good' : 'bad') + '">' + (group.enabled ? 'enabled' : 'disabled') + '</span><span>' + escapeHtml(group.name) + '</span></div>' + (group.url ? '<a class="button secondary" target="_blank" href="' + escapeHtml(group.url) + '">Open</a>' : '') + '</article>'
      ).join('');
    }

    function renderRuns(items) {
      $('runs').innerHTML = '<h2>Recent Runs</h2>' + (items.length ? items.map((entry) => {
        const result = entry.result || {};
        return '<article class="item"><div class="meta"><span class="pill ' + (result.ok ? 'good' : 'bad') + '">' + (result.ok ? 'ok' : 'error') + '</span><span>' + escapeHtml(fmt(entry.finishedAt)) + '</span></div><pre>' + escapeHtml(JSON.stringify(result, null, 2)) + '</pre></article>';
      }).join('') : '<div class="empty">No runs yet.</div>');
    }

    function render() {
      if (!state?.ok) return;
      const s = state.status;
      $('subtitle').innerHTML = 'Last run: <b>' + escapeHtml(fmt(s.lastRunAt)) + '</b>' + (s.lastError ? ' · <span class="bad">Last error: ' + escapeHtml(s.lastError.message) + '</span>' : '');
      renderMetrics(s);
      renderReplies(state.replies || []);
      renderApprovals(state.approvals || []);
      renderSkipped(state.skipped || []);
      renderRules(state);
      renderRuns(state.history || []);
      $('paths').textContent = 'config: ' + s.configPath + '\\nstate: ' + s.statePath + '\\nhistory: ' + s.historyPath + '\\nupdated: ' + state.now;
    }

    document.querySelectorAll('.tab').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
        document.querySelectorAll('.section').forEach((section) => section.classList.remove('active'));
        button.classList.add('active');
        $(button.dataset.tab).classList.add('active');
      });
    });
    $('refreshBtn').addEventListener('click', load);
    $('pollBtn').addEventListener('click', runPoll);
    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
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
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
      writeText(res, 200, dashboardHtml(), 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, configPath, statePath });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/dashboard-data') {
      sendJson(res, 200, dashboardData());
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
