// src/llm/client.js
// Provider abstraction — swap Gemini / Groq / OpenRouter via env; optional cross-provider fallback

const GeminiClient = require('./gemini');
const GroqClient = require('./groq');
const OpenRouterClient = require('./openrouter');
const logger = require('../utils/logger');

/** @type {import('./gemini') | import('./groq') | import('./openrouter') | null} */
let _client = null;
let _clientProvider = null;

const PROVIDER_ENV_KEYS = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function providerHasKey(provider) {
  const envKey = PROVIDER_ENV_KEYS[provider];
  return Boolean(envKey && process.env[envKey]);
}

function getProviderChain() {
  const primary = (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase();
  const extra = (process.env.LLM_FALLBACK_PROVIDERS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const chain = [primary, ...extra.filter(p => p !== primary)];
  return [...new Set(chain)];
}

function buildClient(provider) {
  if (provider === 'gemini') {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not set in .env');
    return new GeminiClient(key);
  }
  if (provider === 'groq') {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY not set in .env');
    return new GroqClient(key);
  }
  if (provider === 'openrouter') {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('OPENROUTER_API_KEY not set in .env');
    return new OpenRouterClient(key);
  }
  throw new Error(`Unknown LLM provider: ${provider}. Use gemini, groq, or openrouter`);
}

function getLLMClient(provider = process.env.LLM_PROVIDER || 'gemini') {
  const normalized = String(provider).trim().toLowerCase();
  if (_client && _clientProvider === normalized) return _client;

  _client = buildClient(normalized);
  _clientProvider = normalized;

  if (normalized === 'openrouter') {
    const models = _client.modelList?.length ? _client.modelList.join(', ') : 'openrouter/free';
    logger.info('LLM', `Using OpenRouter (provider: openrouter, models: ${models})`);
  } else if (normalized === 'groq') {
    logger.info('LLM', `Using Groq (provider: groq)`);
  } else {
    logger.info('LLM', `Using Gemini Flash (provider: gemini)`);
  }

  return _client;
}

function isTransientLlmError(err) {
  const msg = String(err?.message || err).toLowerCase();
  if (/429|503|502|500|408|rate.?limit|overloaded|unavailable|timeout|econnreset|etimedout|fetch failed/.test(msg)) {
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Wrapper: retries per provider, then optional fallback chain
async function llmComplete(prompt, options = {}) {
  const chain = getProviderChain().filter(providerHasKey);
  if (!chain.length) {
    throw new Error('No LLM API keys configured. Set GEMINI_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY.');
  }

  const attemptsPerProvider = Math.max(1, parseInt(process.env.LLM_RETRY_ATTEMPTS || '3', 10));
  let lastErr = null;

  for (let pi = 0; pi < chain.length; pi++) {
    const provider = chain[pi];
    for (let attempt = 1; attempt <= attemptsPerProvider; attempt++) {
      try {
        const client = getLLMClient(provider);
        return await client.complete(prompt, options);
      } catch (err) {
        lastErr = err;
        const retryable = isTransientLlmError(err);
        const isLastAttempt = attempt === attemptsPerProvider;
        const isLastProvider = pi === chain.length - 1;

        if (!retryable && isLastAttempt && isLastProvider) throw err;

        if (isLastAttempt) {
          if (!isLastProvider) {
            logger.warn('LLM', `Provider ${provider} failed after ${attemptsPerProvider} attempt(s), trying next...`, err.message);
          }
          break;
        }

        const waitMs = Math.min(30_000, 1000 * attempt * (retryable ? 2 : 1));
        logger.warn('LLM', `[${provider}] attempt ${attempt}/${attemptsPerProvider} failed, retrying in ${waitMs}ms...`, err.message);
        await sleep(waitMs);
      }
    }
  }

  throw lastErr || new Error('LLM completion failed');
}

async function llmChat(history, options = {}) {
  const provider = getProviderChain().find(providerHasKey) || process.env.LLM_PROVIDER || 'gemini';
  const client = getLLMClient(provider);
  return client.chat(history, options);
}

module.exports = { getLLMClient, llmComplete, llmChat, getProviderChain, providerHasKey };
