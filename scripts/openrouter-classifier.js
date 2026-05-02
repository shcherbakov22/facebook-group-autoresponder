const https = require('node:https');

function requestJson(method, url, { headers = {}, body, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(url, {
      method,
      timeout: timeoutMs,
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
        reject(new Error(`OpenRouter ${method} failed ${res.statusCode}: ${text.slice(0, 500)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`OpenRouter ${method} timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('OpenRouter response did not contain JSON');
    return JSON.parse(match[0]);
  }
}

function buildPrompt({ text, groupName, targetType, categories }) {
  return [
    {
      role: 'system',
      content: [
        'You classify Russian/Ukrainian/Facebook group posts and comments for a psychotherapy lead-monitoring bot.',
        'Relevant means the author is directly presenting their own minor child/teen problem as a parent/guardian, with a complaint, request for help, or clear unresolved concern.',
        'Examples of relevant themes: child does nothing, no motivation, refuses homework/study, phone/games all day, aggression, tantrums, does not listen, school problems.',
        'Not relevant: therapists advertising services, general professional discussions, jokes, politics, unrelated adult problems, advice-only posts without a parent problem.',
        'Not relevant: someone giving advice to another parent, replying in a debate, commenting on parenting theory, or discussing children generally unless the author clearly presents their own child/teen problem or asks for help.',
        'Not relevant: adult children, partners, employees, students/clients/patients, metaphors like "is he a child?", or stories about a child that do not ask for help or describe a current problem needing help.',
        'For comments, classify only the comment author text; do not infer a parent problem from quoted parent text, surrounding thread text, UI labels, likes, shares, translations, or names.',
        'When unsure, choose not relevant with high confidence.',
        'Return exactly one minified JSON object and nothing else.',
        'Use exactly these keys: relevant, confidence, category, reason, replyTemplate.',
        'If not relevant return {"relevant":false,"confidence":0.99,"category":"other","reason":"...","replyTemplate":null}.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        outputSchema: {
          relevant: 'boolean',
          confidence: 'number 0..1',
          category: categories,
          reason: 'short English reason',
          replyTemplate: 'string id or null',
        },
        groupName,
        targetType,
        text: String(text || '').slice(0, 6000),
      }),
    },
  ];
}

async function classifyWithOpenRouter({ text, groupName, targetType, config }) {
  const openrouter = config.openrouter || {};
  const classifier = config.semanticClassifier || {};
  const apiKeyName = openrouter.apiKeyEnv || 'OPENROUTER_API_KEY';
  const apiKey = process.env[apiKeyName];
  if (!apiKey) throw new Error(`Missing OpenRouter API key env ${apiKeyName}`);

  const model = openrouter.model || 'openai/gpt-oss-120b:free';
  const messages = buildPrompt({
    text,
    groupName,
    targetType,
    categories: classifier.categories || ['child_behavior_motivation', 'child_school_refusal', 'child_phone_games', 'child_aggression', 'other'],
  });
  let lastError = null;
  let parsed = null;
  for (let attempt = 1; attempt <= Number(openrouter.retries || 3); attempt += 1) {
    try {
      const response = await requestJson('POST', 'https://openrouter.ai/api/v1/chat/completions', {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': openrouter.siteUrl || 'http://127.0.0.1:4020',
          'X-Title': openrouter.appName || 'Facebook Group Autoresponder',
        },
        timeoutMs: Number(openrouter.timeoutMs || 45000),
        body: {
          model,
          messages,
          temperature: 0,
          max_tokens: Number(openrouter.maxTokens || 180),
          ...(openrouter.responseFormat === true ? { response_format: { type: 'json_object' } } : {}),
        },
      });
      const content = response.choices?.[0]?.message?.content || '';
      parsed = extractJson(content);
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  if (!parsed) throw lastError || new Error('OpenRouter classification failed');
  return {
    relevant: Boolean(parsed.relevant),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
    category: String(parsed.category || 'other'),
    reason: String(parsed.reason || ''),
    replyTemplate: parsed.replyTemplate ? String(parsed.replyTemplate) : null,
    model,
  };
}

module.exports = { classifyWithOpenRouter };
