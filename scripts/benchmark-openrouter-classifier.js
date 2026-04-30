#!/usr/bin/env node

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const outputDir = path.resolve(__dirname, '..', 'state', 'semantic-tests');
const samples = [
  ['pos', 'Ребенок ничего не делает, не хочет учиться, только телефон и игры. Что делать?'],
  ['pos', 'Подросток перестал делать уроки, грубит, мотивации нет вообще.'],
  ['pos', 'Сын 14 лет целыми днями играет, школу забросил, на разговоры не реагирует.'],
  ['pos', 'Дочь не слушается, истерики каждый день, учиться не хочет.'],
  ['pos', 'Дитина нічого не робить, сидить у телефоні, уроки не виконує.'],
  ['pos', 'Підліток не хоче вчитися, агресивно реагує на будь-які прохання.'],
  ['pos', 'Не могу заставить ребенка делать домашку, постоянно в компьютере.'],
  ['pos', 'Ребёнок говорит что ему ничего не интересно, лежит весь день.'],
  ['pos', 'Мой сын начал прогуливать школу и врет, что делать родителям?'],
  ['pos', 'Подросток кричит, хлопает дверями, не делает ничего по дому.'],
  ['neg', 'Коллеги, приглашаю психологов на вебинар о супервизии.'],
  ['neg', 'Психотерапевт онлайн, консультации для взрослых, запись в личные сообщения.'],
  ['neg', 'Ищу специалиста по КПТ для взрослого клиента с тревожностью.'],
  ['neg', 'Статья о подростковом возрасте и развитии личности.'],
  ['neg', 'Психологи, как вы оформляете договор с клиентом?'],
  ['neg', 'Марафон для родителей: лекция про мотивацию детей.'],
  ['neg', 'Продам учебники для школы, состояние хорошее.'],
  ['neg', 'Моя мама ничего не делает после работы, как ей помочь?'],
  ['neg', 'Ребенок в терапии: коллеги, какие методики используете?'],
  ['neg', 'Отзывы о детском лагере, ребенку понравилось, всё отлично.'],
];

const variants = [
  {
    id: 'json_mode_350',
    maxTokens: 350,
    responseFormat: true,
    strictPrompt: false,
  },
  {
    id: 'no_response_format_350',
    maxTokens: 350,
    responseFormat: false,
    strictPrompt: false,
  },
  {
    id: 'no_response_format_180',
    maxTokens: 180,
    responseFormat: false,
    strictPrompt: false,
  },
  {
    id: 'strict_no_response_format_180',
    maxTokens: 180,
    responseFormat: false,
    strictPrompt: true,
  },
  {
    id: 'strict_json_mode_180',
    maxTokens: 180,
    responseFormat: true,
    strictPrompt: true,
  },
];

function requestJson(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { raw: text };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
          return;
        }
        const error = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`);
        error.response = parsed;
        reject(error);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  if (!raw) throw new Error('empty content');
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`no json in content: ${raw.slice(0, 120)}`);
    return JSON.parse(match[0]);
  }
}

function messages(text, strictPrompt) {
  const base = [
    'You classify Russian/Ukrainian/Facebook group posts and comments for a psychotherapy lead-monitoring bot.',
    'Relevant means a parent/guardian is complaining, asking for help, or describing child/teen behavior problems.',
    'Not relevant: therapists advertising services, professional discussions, jokes, politics, unrelated adult problems, advice-only posts without a parent problem.',
  ];
  if (strictPrompt) {
    base.push('Return exactly one minified JSON object and nothing else.');
    base.push('Use exactly these keys: relevant, confidence, category, reason, replyTemplate.');
    base.push('If not relevant return {"relevant":false,"confidence":0.99,"category":"other","reason":"...","replyTemplate":null}.');
  } else {
    base.push('Return strict JSON only.');
  }
  return [
    { role: 'system', content: base.join(' ') },
    {
      role: 'user',
      content: JSON.stringify({
        outputSchema: {
          relevant: 'boolean',
          confidence: 'number 0..1',
          category: ['child_behavior_motivation', 'child_school_refusal', 'child_phone_games', 'child_aggression', 'other'],
          reason: 'short English reason',
          replyTemplate: 'string id or null',
        },
        groupName: 'synthetic',
        targetType: 'post',
        text,
      }),
    },
  ];
}

async function classify(apiKey, variant, text) {
  const body = {
    model: 'openai/gpt-oss-120b:free',
    messages: messages(text, variant.strictPrompt),
    temperature: 0,
    max_tokens: variant.maxTokens,
  };
  if (variant.responseFormat) body.response_format = { type: 'json_object' };
  const response = await requestJson('POST', 'https://openrouter.ai/api/v1/chat/completions', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'http://127.0.0.1:4020',
      'X-Title': 'Facebook Group Autoresponder Benchmark',
    },
    body,
  });
  const choice = response.choices?.[0] || {};
  const message = choice.message || {};
  const content = message.content || '';
  const parsed = extractJson(content);
  return {
    parsed,
    raw: {
      finishReason: choice.finish_reason,
      contentLength: content.length,
      messageKeys: Object.keys(message),
      choiceKeys: Object.keys(choice),
      usage: response.usage || null,
    },
  };
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('Missing OPENROUTER_API_KEY');
  fs.mkdirSync(outputDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), variants: [] };

  for (const variant of variants) {
    console.error(`benchmark variant=${variant.id}`);
    const result = {
      ...variant,
      summary: { total: samples.length, tp: 0, tn: 0, fp: 0, fn: 0, errors: 0, empty: 0 },
      results: [],
    };
    for (const [expected, text] of samples) {
      try {
        const classified = await classify(apiKey, variant, text);
        const relevant = Boolean(classified.parsed.relevant);
        const predicted = relevant ? 'pos' : 'neg';
        if (expected === 'pos' && predicted === 'pos') result.summary.tp += 1;
        else if (expected === 'neg' && predicted === 'neg') result.summary.tn += 1;
        else if (expected === 'neg' && predicted === 'pos') result.summary.fp += 1;
        else if (expected === 'pos' && predicted === 'neg') result.summary.fn += 1;
        result.results.push({ expected, predicted, parsed: classified.parsed, raw: classified.raw, text });
      } catch (error) {
        result.summary.errors += 1;
        if (/empty content/i.test(error.message)) result.summary.empty += 1;
        result.results.push({ expected, error: error.message, text });
      }
    }
    report.variants.push(result);
    console.error(`summary ${variant.id}: ${JSON.stringify(result.summary)}`);
  }

  report.finishedAt = new Date().toISOString();
  const file = path.join(outputDir, `openrouter-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: file,
    summaries: report.variants.map((variant) => ({ id: variant.id, summary: variant.summary })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
