// src/execify/client.js
// HTTP client for Execify API

const logger = require('../utils/logger');

const BASE_URL = process.env.EXECIFY_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.EXECIFY_API_KEY || '';

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
  };
}

const TIMEOUT_MS = parseInt(process.env.EXECIFY_TIMEOUT_MS || '60000', 10);

async function httpPost(urlPath, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${urlPath}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Execify ${urlPath} error ${res.status}: ${txt}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function httpGet(urlPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${urlPath}`, {
      method: 'GET',
      headers: headers(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Execify ${urlPath} error ${res.status}: ${txt}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

// Create a persistent session workspace
async function createSession() {
  logger.debug('Execify', 'Creating session');
  return httpPost('/session/create', {});
}

// Delete session when job is done
async function deleteSession(sessionId) {
  const res = await fetch(`${BASE_URL}/session/${sessionId}`, {
    method: 'DELETE',
    headers: headers(),
  });
  return res.json();
}

// Execute code in a session
async function execute({ language, code, sessionId }) {
  const payload = {
    type: 'execute',
    language,
    code,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
  logger.debug('Execify', `Executing ${language} code (${code.length} chars) in session ${sessionId}`);
  return httpPost('/run', payload);
}

// Run a named command
async function command({ name, params = {}, sessionId }) {
  const payload = {
    type: 'command',
    command: name,
    params,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
  return httpPost('/run', payload);
}

// Get available libraries — called once on startup
async function getInstalledModules() {
  return httpGet('/installed-modules');
}

// Get capabilities
async function getCapabilities() {
  return httpGet('/capabilities');
}

// Health check
async function health() {
  return httpGet('/health');
}

module.exports = { createSession, deleteSession, execute, command, getInstalledModules, getCapabilities, health };
