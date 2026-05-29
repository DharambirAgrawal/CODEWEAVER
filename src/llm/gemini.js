// src/llm/gemini.js
// Gemini Flash integration — primary LLM for all orchestration turns

const logger = require('../utils/logger');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10);

class GeminiClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.provider = 'gemini';
    this.model = GEMINI_MODEL;
  }

  // Core completion — single turn, returns text string
  async complete(prompt, options = {}) {
    const { maxTokens = 4096, temperature = 0.2, jsonObject = false } = options;

    const generationConfig = {
      maxOutputTokens: maxTokens,
      temperature,
    };
    if (jsonObject) {
      generationConfig.responseMimeType = 'application/json';
    }

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    };

    const model = options.model || this.model;
    const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${this.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    const data = await res.json();

    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('Gemini returned no candidates');

    if (candidate.finishReason === 'SAFETY') {
      throw new Error('Gemini blocked response for safety reasons');
    }

    const text = candidate.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) throw new Error('Gemini returned empty response');

    logger.debug('Gemini', `Response: ${text.length} chars (${model}), finish: ${candidate.finishReason}`);
    return text.trim();
  }

  async chat(history, options = {}) {
    const { maxTokens = 4096, temperature = 0.2, jsonObject = false } = options;

    const generationConfig = { maxOutputTokens: maxTokens, temperature };
    if (jsonObject) {
      generationConfig.responseMimeType = 'application/json';
    }

    const body = {
      contents: history.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      })),
      generationConfig,
    };

    const model = options.model || this.model;
    const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${this.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    return text.trim();
  }
}

module.exports = GeminiClient;
