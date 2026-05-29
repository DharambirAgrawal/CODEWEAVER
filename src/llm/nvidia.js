// src/llm/nvidia.js
// NVIDIA NIM integration — OpenAI-compatible chat completions

const logger = require('../utils/logger');

const DEFAULT_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const NV_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10);

// Keep to chat/instruct language + coding models only.
const DEFAULT_MODELS = [
  'qwen/qwen3-coder-480b-a35b-instruct',
  'mistralai/mistral-large-3-675b-instruct-2512',
  'minimaxai/minimax-m2.7',
  'stepfun-ai/step-3.5-flash',
  'bytedance/seed-oss-36b-instruct',
  'mistralai/mistral-nemotron',
  'abacusai/dracarys-llama-3.1-70b-instruct',
  'meta/llama-4-maverick-17b-128e-instruct',
  'upstage/solar-10.7b-instruct',
  'nvidia/nemotron-mini-4b-instruct',
  'google/gemma-3n-e4b-it',
  'google/gemma-3n-e2b-it',
  'google/gemma-2-2b-it',
];

function parseModelList() {
  const raw = process.env.NVIDIA_MODELS || '';
  const list = raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  return list.length ? list : DEFAULT_MODELS;
}

function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

class NvidiaClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.provider = 'nvidia';
    this.modelList = options.modelList && options.modelList.length ? options.modelList : parseModelList();
    this.baseUrl = options.baseUrl || process.env.NVIDIA_API_URL || DEFAULT_API_URL;
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
          stream: false,
        };
        if (useJsonObject) {
          body.response_format = { type: 'json_object' };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), NV_TIMEOUT_MS);
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
          lastErr = new Error(`NVIDIA API error ${res.status}: ${errText}`);

          if (useJsonObject && (res.status === 400 || res.status === 422)) {
            logger.warn(
              'NVIDIA',
              `Model ${model} rejected json_object mode, retrying without structured output...`,
            );
            continue;
          }

          if (RETRYABLE_STATUS.has(res.status)) {
            logger.warn('NVIDIA', `Model ${model} unavailable (Status ${res.status}), trying next model...`);
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
    if (!text) throw new Error('NVIDIA returned empty response');

    logger.debug('NVIDIA', `Response: ${text.length} chars`);
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

module.exports = NvidiaClient;
