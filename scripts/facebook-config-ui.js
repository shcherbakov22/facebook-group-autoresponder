#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const configPath = process.env.FB_BOT_CONFIG || path.join(projectRoot, 'config', 'config.json');
const statePath = process.env.FB_BOT_STATE || path.join(projectRoot, 'state', 'state.json');
const historyPath = process.env.FB_BOT_HISTORY || path.join(projectRoot, 'state', 'history.jsonl');
const port = Number(process.env.FB_CONFIG_UI_PORT || 4021);

function readJson(filePath, fallback) {
  try {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    return text ? JSON.parse(text) : fallback;
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1024 * 1024) {
        req.destroy(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function lines(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

function parseLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function numberValue(form, key, fallback) {
  const value = Number(form.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function boolValue(form, key) {
  return form.get(key) === 'on';
}

function firstRule(config) {
  config.rules ||= [];
  let rule = config.rules.find((item) => item.enabled) || config.rules[0];
  if (!rule) {
    rule = { id: 'child-behavior-complaint', enabled: true, match: 'any', queries: [], regexes: [], response: '', cooldownMinutes: 0 };
    config.rules.push(rule);
  }
  rule.queries ||= [];
  rule.regexes ||= [];
  return rule;
}

function saveConfigFromForm(form) {
  const config = readJson(configPath, {});
  config.dryRun = boolValue(form, 'dryRun');
  config.approvalMode = boolValue(form, 'approvalMode');
  config.polling ||= {};
  config.polling.lookbackMinutes = numberValue(form, 'lookbackMinutes', 30);
  config.polling.feedLimitPerGroup = numberValue(form, 'feedLimitPerGroup', 60);
  config.polling.includeComments = boolValue(form, 'includeComments');
  config.polling.commentLimitPerPost = numberValue(form, 'commentLimitPerPost', 8);
  config.polling.onlyNewTargets = boolValue(form, 'onlyNewTargets');
  config.polling.baselineSeenOnFirstRun = boolValue(form, 'baselineSeenOnFirstRun');
  config.scraper ||= {};
  config.scraper.useChronologicalFeed = boolValue(form, 'useChronologicalFeed');
  config.scraper.scrollsPerGroup = numberValue(form, 'scrollsPerGroup', 8);
  config.scraper.groupTimeoutMs = numberValue(form, 'groupTimeoutMs', 180000);
  config.safety ||= {};
  config.safety.maxRepliesPerRun = numberValue(form, 'maxRepliesPerRun', 4);
  config.safety.minMinutesBetweenRepliesPerGroup = numberValue(form, 'minMinutesBetweenRepliesPerGroup', 0);

  config.groups = [];
  for (let i = 0; i < 8; i += 1) {
    const id = String(form.get(`group_${i}_id`) || '').trim();
    const url = String(form.get(`group_${i}_url`) || '').trim();
    const name = String(form.get(`group_${i}_name`) || '').trim();
    if (!id && !url && !name) continue;
    config.groups.push({
      id,
      url,
      name,
      enabled: boolValue(form, `group_${i}_enabled`)
    });
  }

  const rule = firstRule(config);
  rule.enabled = boolValue(form, 'ruleEnabled');
  rule.semantic = boolValue(form, 'ruleSemantic');
  rule.semanticThreshold = numberValue(form, 'ruleSemanticThreshold', 0.75);
  rule.response = String(form.get('ruleResponse') || '').trim();
  rule.queries = parseLines(form.get('ruleQueries'));
  rule.regexes = parseLines(form.get('ruleRegexes'));
  rule.cooldownMinutes = numberValue(form, 'ruleCooldownMinutes', 0);

  writeJsonAtomic(configPath, config);
}

function statusSummary() {
  const state = readJson(statePath, {});
  const history = (() => {
    try {
      return fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean).slice(-5).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  })();
  return { state, history };
}

function renderPage(message = '') {
  const config = readJson(configPath, {});
  const groups = [...(config.groups || [])];
  while (groups.length < 5) groups.push({ id: '', url: '', name: '', enabled: false });
  const rule = firstRule(config);
  const { state, history } = statusSummary();
  const lastRun = state.lastRunAt || 'never';
  const lastError = state.lastError || '';
  const repliedCount = Object.keys(state.replied || {}).length;
  const seenCount = Math.max(0, Object.keys(state.seen || {}).filter((key) => !key.startsWith('__')).length);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Facebook Bot Config</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --text:#17202a; --muted:#5f6b7a; --line:#d8dde6; --accent:#0f766e; --danger:#b42318; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
    header { background:#13201f; color:#fff; padding:18px 24px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
    header h1 { font-size:20px; margin:0; font-weight:650; }
    main { max-width:1180px; margin:0 auto; padding:22px; }
    form { display:grid; gap:18px; }
    section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; }
    h2 { font-size:16px; margin:0 0 14px; }
    .grid { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; }
    .group { display:grid; grid-template-columns: 52px 1fr 1.25fr 1.5fr; gap:10px; align-items:end; margin-bottom:10px; }
    label { display:grid; gap:6px; font-size:13px; color:var(--muted); }
    input, textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px 10px; font:inherit; color:var(--text); background:#fff; }
    textarea { min-height:96px; resize:vertical; }
    input[type="checkbox"] { width:auto; transform:translateY(1px); }
    .check { display:flex; align-items:center; gap:8px; min-height:38px; color:var(--text); }
    .actions { display:flex; gap:10px; align-items:center; position:sticky; bottom:0; background:rgba(246,247,249,.94); padding:12px 0; }
    button { border:0; border-radius:6px; padding:10px 14px; font:inherit; color:#fff; background:var(--accent); cursor:pointer; }
    .meta { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; }
    .stat { background:#f9fafb; border:1px solid var(--line); border-radius:6px; padding:10px; }
    .stat b { display:block; font-size:12px; color:var(--muted); margin-bottom:4px; }
    .message { margin:0 0 16px; color:var(--accent); font-weight:650; }
    .error { color:var(--danger); overflow-wrap:anywhere; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; margin:0; font-size:12px; color:#2f3b49; }
    @media (max-width: 860px) { .grid, .meta, .group { grid-template-columns:1fr; } header { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <header>
    <h1>Facebook Bot Config</h1>
    <div>${escapeHtml(config.dryRun ? 'Dry run' : 'Live posting')} · ${escapeHtml((config.groups || []).filter((group) => group.enabled).length)} groups · ${escapeHtml(config.polling?.feedLimitPerGroup || 0)} feed limit</div>
  </header>
  <main>
    ${message ? `<p class="message">${escapeHtml(message)}</p>` : ''}
    <form method="post" action="save">
      <section>
        <h2>Status</h2>
        <div class="meta">
          <div class="stat"><b>Last run</b>${escapeHtml(lastRun)}</div>
          <div class="stat"><b>Replies recorded</b>${escapeHtml(repliedCount)}</div>
          <div class="stat"><b>Seen posts</b>${escapeHtml(seenCount)}</div>
          <div class="stat"><b>Last error</b><span class="${lastError ? 'error' : ''}">${escapeHtml(lastError || 'none')}</span></div>
        </div>
      </section>

      <section>
        <h2>Run Mode</h2>
        <div class="grid">
          <label class="check"><input type="checkbox" name="dryRun" ${config.dryRun ? 'checked' : ''}> Dry run</label>
          <label class="check"><input type="checkbox" name="approvalMode" ${config.approvalMode ? 'checked' : ''}> Approval queue</label>
          <label>Max replies per run<input name="maxRepliesPerRun" type="number" min="0" value="${escapeHtml(config.safety?.maxRepliesPerRun ?? 4)}"></label>
          <label>Group cooldown minutes<input name="minMinutesBetweenRepliesPerGroup" type="number" min="0" value="${escapeHtml(config.safety?.minMinutesBetweenRepliesPerGroup ?? 0)}"></label>
        </div>
      </section>

      <section>
        <h2>Polling</h2>
        <div class="grid">
          <label>Lookback minutes<input name="lookbackMinutes" type="number" min="1" value="${escapeHtml(config.polling?.lookbackMinutes ?? 30)}"></label>
          <label>Feed limit per group<input name="feedLimitPerGroup" type="number" min="1" value="${escapeHtml(config.polling?.feedLimitPerGroup ?? 60)}"></label>
          <label>Comment limit per post<input name="commentLimitPerPost" type="number" min="0" value="${escapeHtml(config.polling?.commentLimitPerPost ?? 8)}"></label>
          <label>Scrolls per group<input name="scrollsPerGroup" type="number" min="0" value="${escapeHtml(config.scraper?.scrollsPerGroup ?? 8)}"></label>
          <label>Group timeout ms<input name="groupTimeoutMs" type="number" min="10000" step="1000" value="${escapeHtml(config.scraper?.groupTimeoutMs ?? 180000)}"></label>
          <label class="check"><input type="checkbox" name="includeComments" ${config.polling?.includeComments ? 'checked' : ''}> Scan comments</label>
          <label class="check"><input type="checkbox" name="onlyNewTargets" ${config.polling?.onlyNewTargets ? 'checked' : ''}> Only new posts</label>
          <label class="check"><input type="checkbox" name="baselineSeenOnFirstRun" ${config.polling?.baselineSeenOnFirstRun ? 'checked' : ''}> Baseline first run</label>
          <label class="check"><input type="checkbox" name="useChronologicalFeed" ${config.scraper?.useChronologicalFeed !== false ? 'checked' : ''}> Chronological feed</label>
        </div>
      </section>

      <section>
        <h2>Groups</h2>
        ${groups.slice(0, 8).map((group, index) => `
          <div class="group">
            <label class="check"><input type="checkbox" name="group_${index}_enabled" ${group.enabled ? 'checked' : ''}> On</label>
            <label>ID<input name="group_${index}_id" value="${escapeHtml(group.id)}"></label>
            <label>Name<input name="group_${index}_name" value="${escapeHtml(group.name)}"></label>
            <label>URL<input name="group_${index}_url" value="${escapeHtml(group.url)}"></label>
          </div>
        `).join('')}
      </section>

      <section>
        <h2>Response Rule</h2>
        <div class="grid">
          <label class="check"><input type="checkbox" name="ruleEnabled" ${rule.enabled ? 'checked' : ''}> Rule enabled</label>
          <label class="check"><input type="checkbox" name="ruleSemantic" ${rule.semantic ? 'checked' : ''}> Semantic classifier</label>
          <label>Semantic threshold<input name="ruleSemanticThreshold" type="number" min="0" max="1" step="0.01" value="${escapeHtml(rule.semanticThreshold ?? 0.75)}"></label>
          <label>Cooldown minutes<input name="ruleCooldownMinutes" type="number" min="0" value="${escapeHtml(rule.cooldownMinutes ?? 0)}"></label>
        </div>
        <label>Default response<textarea name="ruleResponse">${escapeHtml(rule.response)}</textarea></label>
        <div class="grid" style="grid-template-columns:1fr 1fr; margin-top:12px;">
          <label>Keyword queries<textarea name="ruleQueries">${escapeHtml(lines(rule.queries))}</textarea></label>
          <label>Regexes<textarea name="ruleRegexes">${escapeHtml(lines(rule.regexes))}</textarea></label>
        </div>
      </section>

      <section>
        <h2>Recent Runs</h2>
        <pre>${escapeHtml(JSON.stringify(history.map((entry) => entry.result || entry), null, 2))}</pre>
      </section>

      <div class="actions">
        <button type="submit">Save Configuration</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

function sendHtml(res, statusCode, body) {
  const payload = Buffer.from(body);
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      sendHtml(res, 200, renderPage(url.searchParams.get('saved') ? 'Configuration saved. The next poll will use it.' : ''));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/save') {
      const form = new URLSearchParams(await readBody(req));
      saveConfigFromForm(form);
      redirect(res, './?saved=1');
      return;
    }
    sendHtml(res, 404, renderPage('Not found.'));
  } catch (error) {
    sendHtml(res, 500, `<pre>${escapeHtml(error.stack || error.message || error)}</pre>`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`facebook-config-ui listening on 127.0.0.1:${port}`);
});
