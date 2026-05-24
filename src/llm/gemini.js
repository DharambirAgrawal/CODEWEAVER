// src/llm/gemini.js
// Gemini Flash integration — primary LLM for all orchestration turns

const logger = require('../utils/logger');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

class GeminiClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.provider = 'gemini';
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

    const url = `${GEMINI_API_URL}?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    const data = await res.json();

    // Extract text from response
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error('Gemini returned no candidates');

    if (candidate.finishReason === 'SAFETY') {
      throw new Error('Gemini blocked response for safety reasons');
    }

    const text = candidate.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) throw new Error('Gemini returned empty response');

    logger.debug('Gemini', `Response: ${text.length} chars, finish: ${candidate.finishReason}`);
    return text.trim();
  }

  // Multi-turn conversation — takes history array, returns text
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

    const url = `${GEMINI_API_URL}?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

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
