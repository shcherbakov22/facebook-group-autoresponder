#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const configPath = process.argv[2] || path.resolve(__dirname, '..', 'config', 'config.json');
const text = process.argv.slice(3).join(' ');

if (!text) {
  console.error('Usage: node scripts/test-match.js [config.json] "message text to test"');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const source = text.toLowerCase();
const matches = [];

for (const rule of config.rules || []) {
  if (!rule.enabled) continue;
  const checks = [
    ...(rule.queries || []).map((query) => source.includes(String(query).toLowerCase())),
    ...(rule.regexes || []).map((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(text);
      } catch {
        return false;
      }
    })
  ];
  const matched = rule.match === 'all' ? checks.every(Boolean) : checks.some(Boolean);
  if (matched) matches.push({ id: rule.id, response: rule.response });
}

console.log(JSON.stringify({ text, matches }, null, 2));
