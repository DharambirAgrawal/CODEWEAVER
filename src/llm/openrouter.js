// src/llm/openrouter.js
// OpenRouter integration — OpenAI-compatible chat completions

const logger = require('../utils/logger');

const DEFAULT_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const OR_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10);

function parseModelList() {
  const raw = process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL || '';
  const list = raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  return list.length ? list : ['openrouter/free'];
}

function buildHeaders(apiKey) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const referer = process.env.OPENROUTER_APP_URL || process.env.OPENROUTER_REFERER;
  const title = process.env.OPENROUTER_APP_NAME;

  if (referer) headers['HTTP-Referer'] = referer;
  if (title) headers['X-Title'] = title;

  return headers;
}

class OpenRouterClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.provider = 'openrouter';
    this.modelList = options.modelList && options.modelList.length ? options.modelList : parseModelList();
    this.baseUrl = options.baseUrl || process.env.OPENROUTER_API_URL || DEFAULT_API_URL;
  }

  async _fetchWithFallback(messages, options) {
    const { maxTokens = 4096, temperature = 0.2, jsonObject = false, model: forcedModel = null } = options;
    let lastErr = null;
    const jsonAttempts = jsonObject ? [true, false] : [false];
    const models = forcedModel ? [forcedModel] : this.modelList;

    for (const model of models) {
      for (const useJsonObject of jsonAttempts) {
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
        const timer = setTimeout(() => controller.abort(), OR_TIMEOUT_MS);
        let res;
        try {
          res = await fetch(this.baseUrl, {
            method: 'POST',
            headers: buildHeaders(this.apiKey),
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!res.ok) {
          const errText = await res.text();
          lastErr = new Error(`OpenRouter API error ${res.status}: ${errText}`);

          if (useJsonObject && (res.status === 400 || res.status === 422)) {
            logger.warn(
              'OpenRouter',
              `Model ${model} rejected json_object mode, retrying without structured output...`,
            );
            continue;
          }

          if (RETRYABLE_STATUS.has(res.status)) {
            logger.warn('OpenRouter', `Model ${model} unavailable (Status ${res.status}), trying next model...`);
            break;
          }

          throw lastErr;
        }

        const data = await res.json();
        return data;
      }
    }

    throw lastErr;
  }

  async complete(prompt, options = {}) {
    const messages = [{ role: 'user', content: prompt }];
    const data = await this._fetchWithFallback(messages, options);

    const text = data.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('OpenRouter returned empty response');

    logger.debug('OpenRouter', `Response: ${text.length} chars`);
    return text.trim();
  }

  async chat(history, options = {}) {
    const messages = history.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
    const data = await this._fetchWithFallback(messages, options);

    return data.choices?.[0]?.message?.content?.trim() || '';
  }
}

module.exports = OpenRouterClient;
