// src/llm/client.js
// Provider abstraction — swap Gemini / Groq / OpenRouter via env; optional cross-provider fallback

const GeminiClient = require('./gemini');
const GroqClient = require('./groq');
const OpenRouterClient = require('./openrouter');
const NvidiaClient = require('./nvidia');
const logger = require('../utils/logger');

/** @type {import('./gemini') | import('./groq') | import('./openrouter') | import('./nvidia') | null} */
let _client = null;
let _clientProvider = null;

const PROVIDER_ENV_KEYS = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
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
  if (provider === 'nvidia') {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) throw new Error('NVIDIA_API_KEY not set in .env');
    return new NvidiaClient(key);
  }
  throw new Error(`Unknown LLM provider: ${provider}. Use gemini, groq, openrouter, or nvidia`);
}

function getLLMClient(provider = process.env.LLM_PROVIDER || 'gemini') {
  const normalized = String(provider).trim().toLowerCase();
  if (_client && _clientProvider === normalized) return _client;

  _client = buildClient(normalized);
  _clientProvider = normalized;

  if (normalized === 'openrouter') {
    const models = _client.modelList?.length ? _client.modelList.join(', ') : 'openrouter/free';
    logger.info('LLM', `Using OpenRouter (provider: openrouter, models: ${models})`);
  } else if (normalized === 'nvidia') {
    const models = _client.modelList?.length ? _client.modelList.join(', ') : 'default';
    logger.info('LLM', `Using NVIDIA (provider: nvidia, models: ${models})`);
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

function getPrimaryProvider() {
  const chain = getProviderChain().filter(providerHasKey);
  return chain[0] || null;
}

function getModelTargets(provider, count) {
  const client = getLLMClient(provider);
  const list = Array.isArray(client.modelList) ? client.modelList : [];
  if (!list.length) return [{ provider, model: null }];
  return list.slice(0, Math.max(1, count)).map(model => ({ provider, model }));
}

function getParallelTargets(strategy = {}) {
  const providers = (strategy.providers && strategy.providers.length
    ? strategy.providers
    : getProviderChain().filter(providerHasKey)
  ).filter(Boolean);

  if (!providers.length) return [];

  const count = Math.max(1, parseInt(String(strategy.count || '1'), 10));
  const mode = String(strategy.scope || 'all').toLowerCase(); // all | provider

  if (mode === 'provider') {
    return getModelTargets(providers[0], count);
  }

  const targets = [];
  let cursor = 0;
  while (targets.length < count) {
    let progressed = false;
    for (const provider of providers) {
      const providerTargets = getModelTargets(provider, cursor + 1);
      if (providerTargets[cursor]) {
        targets.push(providerTargets[cursor]);
        progressed = true;
        if (targets.length >= count) break;
      }
    }
    if (!progressed) break;
    cursor += 1;
  }

  return targets;
}

async function completeWithTarget(prompt, options, target) {
  const client = getLLMClient(target.provider);
  const payload = target.model ? { ...options, model: target.model } : options;
  return client.complete(prompt, payload);
}

// Wrapper: retries per provider, then optional fallback chain
async function llmComplete(prompt, options = {}) {
  const chain = getProviderChain().filter(providerHasKey);
  if (!chain.length) {
    throw new Error(
      'No LLM API keys configured. Set GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, or NVIDIA_API_KEY.',
    );
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

async function llmCompleteBestOfN(prompt, options = {}, strategy = {}) {
  const targets = getParallelTargets({
    count: strategy.count,
    providers: strategy.providers,
    scope: strategy.scope,
  });
  if (!targets.length) {
    throw new Error('No LLM provider available for best-of-N generation');
  }

  if (targets.length <= 1) {
    return llmComplete(prompt, options);
  }

  const parsedTimeout = parseInt(String(strategy.timeoutMs ?? '35000'), 10);
  const timeoutMs = Number.isFinite(parsedTimeout) ? parsedTimeout : 35000;
  const disableTimeout = timeoutMs <= 0;
  const targetOpts = {
    ...options,
    rateLimitRetries: strategy.rateLimitRetries ?? 1,
  };

  const jobs = targets.map(async target => {
    const label = target.model ? `${target.provider}:${target.model}` : target.provider;
    try {
      const result = disableTimeout
        ? await completeWithTarget(prompt, targetOpts, target)
        : await Promise.race([
          completeWithTarget(prompt, targetOpts, target),
          sleep(timeoutMs).then(() => {
            throw new Error(`Timed out after ${timeoutMs}ms`);
          }),
        ]);
      return { ok: true, label, text: result };
    } catch (err) {
      return { ok: false, label, error: err };
    }
  });

  const settled = await Promise.all(jobs);
  const winner = settled.find(r => r.ok);
  if (winner) {
    logger.info('LLM', `best-of-${targets.length} winner: ${winner.label}`);
    return winner.text;
  }

  const summary = settled.map(r => `${r.label}: ${String(r.error?.message || r.error)}`).join(' | ');
  logger.warn('LLM', `best-of-${targets.length} failed, falling back to provider chain`);
  logger.warn('LLM', summary);
  return llmComplete(prompt, options);
}

module.exports = {
  getLLMClient,
  llmComplete,
  llmCompleteBestOfN,
  llmChat,
  getProviderChain,
  providerHasKey,
};
