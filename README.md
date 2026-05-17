# Facebook Group Autoresponder

Skeleton for an `n8n`-driven Facebook group autoresponder.

The automation is intentionally split into:

- `scripts/facebook-autoresponder-helper.js`: local helper that exposes the n8n `/poll` endpoint.
- `scripts/facebook-scraper-engine.js`: Playwright backend that polls group pages using a persistent logged-in browser profile.
- `workflows/01-facebook-group-autoresponder-poll.json`: n8n workflow that calls the helper on a schedule.
- `config/config.json`: groups, query rules, safety limits, and dry-run mode.
- `state/state.json`: reply/deduplication state, created automatically.

## Important Constraint

The old official Facebook Groups API has effectively been removed for normal apps. This project now supports `mode: "scraper"` for group monitoring.

The scraper uses a normal persistent browser profile. It does not bypass login checks, checkpoints, CAPTCHA, or account restrictions. If Facebook challenges the session, the helper reports an error and stops.

## Setup

```bash
cd /home/q/n8n-projects/facebook-group-autoresponder
cp config/config.example.json config/config.json
cp config/facebook-bot.env.example config/facebook-bot.env
chmod 600 config/facebook-bot.env
```

Edit:

- `config/config.json`: add real group URLs/IDs, enable the groups, add real rules/responses, and keep `dryRun: true` until tested.
- `config/facebook-bot.env`: set `OPENROUTER_API_KEY` if semantic classification is enabled.

Install Playwright browser binaries:

```bash
cd /home/q/n8n-projects/facebook-group-autoresponder
npx playwright install chromium
```

Create/login the persistent browser profile:

```bash
cd /home/q/n8n-projects/facebook-group-autoresponder
npm run login
```

Log in manually, pass any Facebook checkpoint if shown, then press Enter in the terminal to close the browser.

Install/start the helper:

```bash
doas cp /home/q/n8n-projects/facebook-group-autoresponder/facebook-autoresponder-helper.service /etc/systemd/system/
doas systemctl daemon-reload
doas systemctl enable --now facebook-autoresponder-helper.service
curl -s http://127.0.0.1:4020/health
```

## Configuration UI

The configuration UI is a local-only editor for `config/config.json`. It does not poll Facebook, post replies, clear state, or expose runtime controls.

Run it manually:

```bash
cd /home/q/n8n-projects/facebook-group-autoresponder
npm run config:ui
```

Then open:

```text
http://127.0.0.1:4021/
```

Install/start it as a service:

```bash
doas cp /home/q/n8n-projects/facebook-group-autoresponder/facebook-config-ui.service /etc/systemd/system/
doas systemctl daemon-reload
doas systemctl enable --now facebook-config-ui.service
```

Import the workflow:

```bash
/opt/n8n/node/bin/n8n import:workflow --input=/home/q/n8n-projects/facebook-group-autoresponder/workflows/01-facebook-group-autoresponder-poll.json
```

Then open n8n and manually execute `Facebook Group Autoresponder - Poll`. Leave the workflow inactive until dry-run output looks correct.

## Config Model

`dryRun: true` means matching replies are recorded in state and returned to n8n, but not posted to Facebook.

Semantic rules can use OpenRouter as a second-stage classifier after keyword/regex prefiltering. The default model is:

```json
"openai/gpt-oss-120b:free"
```

Keep `dryRun: true` until enough real matches have been reviewed.

Group example:

```json
{
  "id": "1234567890",
  "url": "https://www.facebook.com/groups/1234567890",
  "name": "Target group name",
  "enabled": true
}
```

Rule example:

```json
{
  "id": "pricing-question",
  "enabled": true,
  "match": "any",
  "queries": ["price", "how much", "cost"],
  "regexes": ["\\bpricing\\b"],
  "response": "The current pricing details are here: ...",
  "cooldownMinutes": 60
}
```

`match: "any"` replies if any query or regex matches.

`match: "all"` replies only when every query/regex matches.

## Test Matching Locally

```bash
node scripts/test-match.js config/config.json "How much does this cost?"
```

## Manual Poll

```bash
curl -s -X POST http://127.0.0.1:4020/poll | jq
```

## Operational Endpoints

```bash
curl -s http://127.0.0.1:4020/status | jq
curl -s 'http://127.0.0.1:4020/history?limit=20' | jq
```

`/status` validates the config before returning. If a group/rule is malformed, the endpoint returns an error instead of letting a scheduled poll fail later.

`/history` reads recent run summaries from `state/history.jsonl`.

## Going Live

Only after dry-run output is correct:

1. Set `dryRun` to `false`.
2. Restart the helper.
3. Manually execute the n8n workflow once.
4. If the result is correct, activate the workflow.

```bash
doas systemctl restart facebook-autoresponder-helper.service
```

## Scraper Notes

- The n8n workflow polls the configured group pages every 15 minutes.
- The scraper requests Facebook's chronological group feed (`sorting_setting=CHRONOLOGICAL`) by default to reduce ranked-feed churn.
- With `onlyNewTargets` enabled, the scraper records stable post IDs in `state/state.json` and only evaluates posts it has not seen before.
- With `baselineSeenOnFirstRun` enabled, the first run records currently visible posts without replying, so live mode starts from future posts instead of the existing feed backlog.
- If `includeComments` is `true`, it opens each discovered post and scans visible comments too.
- For matched comments, live mode currently posts a normal comment on the parent post rather than a nested direct reply.
- Reply posting is best-effort because Facebook changes comment box markup often.
- Keep `maxRepliesPerRun` low while testing.
- If the account is logged out or checkpointed, run `npm run login` again.
- Scrape errors save screenshots/HTML under `state/artifacts` when possible.

## Safety Defaults

- `maxRepliesPerRun`: caps total replies per polling run.
- `minMinutesBetweenRepliesPerGroup`: throttles replies in the same group.
- `cooldownMinutes`: prevents repeating the same rule on the same target too often.
- Reply state is persisted in `state/state.json`.
