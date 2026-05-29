// src/llm/groq.js
// Groq fallback — faster but smaller context window

const logger = require('../utils/logger');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_RATE_LIMIT_RETRIES = 4;
const GROQ_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Parse "Please try again in 16.244s" from Groq error JSON body */
function groqSuggestedRetryMs(errBody) {
  const m = String(errBody).match(/try again in ([\d.]+)\s*s/i);
  if (!m) return null;
  const ms = Math.ceil(parseFloat(m[1], 10) * 1000) + 400;
  return Math.min(120_000, ms);
}

// Models ordered by preference — falls through on 429/503
// Prioritize higher quality, then broader availability/capacity.
// Ordered by free-tier token limits — larger limits first to avoid 413 errors.
// llama-3.1-8b-instant has highest free TPM/TPD; larger models hit limits fast.
const FALLBACK_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-20b',
  'qwen/qwen3-32b',
  'llama-3.3-70b-versatile',
];

class GroqClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.provider = 'groq';
    this.modelList = FALLBACK_MODELS.slice();
  }

  async _fetchWithFallback(messages, options) {
    const {
      maxTokens = 4096,
      temperature = 0.2,
      jsonObject = false,
      model: forcedModel = null,
      rateLimitRetries = GROQ_RATE_LIMIT_RETRIES,
    } = options;
    let lastErr = null;
    const jsonAttempts = jsonObject ? [true, false] : [false];
    const models = forcedModel ? [forcedModel] : FALLBACK_MODELS;

    for (const model of models) {
      jsonAttempts: for (const useJsonObject of jsonAttempts) {
        for (let rateAttempt = 0; rateAttempt < rateLimitRetries; rateAttempt++) {
          const body = {
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
          };
          if (useJsonObject) {
            body.response_format = { type: 'json_object' };
          }

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
          let res;
          try {
            res = await fetch(GROQ_API_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }

          if (res.ok) {
            const data = await res.json();
            return data;
          }

          const errText = await res.text();
          lastErr = new Error(`Groq API error ${res.status}: ${errText}`);

          if (useJsonObject && (res.status === 400 || res.status === 422)) {
            logger.warn('Groq', `Model ${model} rejected json_object mode, retrying without...`);
            continue jsonAttempts;
          }

          if (res.status === 429 || res.status === 503) {
            if (rateAttempt < rateLimitRetries - 1) {
              const wait = groqSuggestedRetryMs(errText) ?? Math.min(30_000, 2000 * (rateAttempt + 1));
              logger.warn(
                'Groq',
                `Model ${model} rate-limited (${res.status}), waiting ${wait}ms then retry ${rateAttempt + 1}/${rateLimitRetries - 1}...`,
              );
              await sleep(wait);
              continue;
            }
            logger.warn('Groq', `Model ${model} still ${res.status} after backoff, trying next model...`);
            break jsonAttempts;
          }

          if (res.status === 413) {
            logger.warn('Groq', `Model ${model} returned 413 (payload too large?), trying next model...`);
            break jsonAttempts;
          }

          throw lastErr;
        }
      }
    }

    throw lastErr;
  }

  async complete(prompt, options = {}) {
    const messages = [{ role: 'user', content: prompt }];
    const data = await this._fetchWithFallback(messages, options);
    
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Groq returned empty response');

    logger.debug('Groq', `Response: ${text.length} chars`);
    return text.trim();
  }

  async chat(history, options = {}) {
    const messages = history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    const data = await this._fetchWithFallback(messages, options);
    
    return data.choices?.[0]?.message?.content?.trim() || '';
  }
}

module.exports = GroqClient;
