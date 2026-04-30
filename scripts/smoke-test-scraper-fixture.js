#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { pollWithScraper } = require('./facebook-scraper-engine.js');

const projectRoot = path.resolve(__dirname, '..');
const statePath = path.join('/tmp', `fb-scraper-fixture-state-${process.pid}.json`);
const state = {
  replied: {},
  cooldowns: {},
  seen: {},
  lastRunAt: null,
  lastError: null
};

function ruleMatches(rule, text) {
  const source = String(text || '').toLowerCase();
  return (rule.queries || []).some((query) => source.includes(String(query).toLowerCase()));
}

function canReply() {
  return { ok: true };
}

function markReplied(currentState, groupId, rule, targetId) {
  currentState.replied[`${targetId}:${rule.id}`] = new Date().toISOString();
}

(async () => {
  const result = await pollWithScraper({
    state,
    ruleMatches,
    canReply,
    markReplied,
    config: {
      mode: 'scraper',
      dryRun: true,
      polling: {
        feedLimitPerGroup: 5,
        includeComments: false
      },
      scraper: {
        headless: true,
        userDataDir: path.join('/tmp', `fb-scraper-fixture-profile-${process.pid}`),
        scrollsPerGroup: 0,
        initialWaitMs: 100,
        waitAfterScrollMs: 100,
        defaultTimeoutMs: 5000
      },
      safety: {
        maxRepliesPerRun: 3
      },
      groups: [
        {
          id: 'fixture-group',
          name: 'Fixture Group',
          enabled: true,
          fixturePath: path.join(projectRoot, 'tests', 'fixtures', 'group-feed.html')
        }
      ],
      rules: [
        {
          id: 'price',
          enabled: true,
          queries: ['price'],
          response: 'Fixture response'
        }
      ]
    }
  });

  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify({ result, statePath }, null, 2));
  if (result.scanned < 2 || result.matched < 1 || result.replies.length < 1) {
    process.exit(1);
  }
})();
