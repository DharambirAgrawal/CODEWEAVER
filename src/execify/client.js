// src/execify/client.js
// HTTP client for Execify API — switches to mock when MOCK_EXECIFY=true

const logger = require('../utils/logger');

const isMock = process.env.MOCK_EXECIFY === 'true';
const BASE_URL = process.env.EXECIFY_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.EXECIFY_API_KEY || 'key-abc123';

// Lazy load mock only when needed
let mock = null;
function getMock() {
  if (!mock) mock = require('../../tests/mock/execifyMock');
  return mock;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY,
  };
}

async function httpPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Execify ${path} error ${res.status}: ${txt}`);
  }
  return res.json();
}

async function httpGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: headers(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Execify ${path} error ${res.status}: ${txt}`);
  }
  return res.json();
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

// Create a persistent session workspace
async function createSession() {
  if (isMock) return getMock().createSession();
  logger.debug('Execify', 'Creating session');
  return httpPost('/session/create', {});
}

// Delete session when job is done
async function deleteSession(sessionId) {
  if (isMock) return getMock().deleteSession(sessionId);
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

  if (isMock) return getMock().run(payload);

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

  if (isMock) return getMock().run(payload);
  return httpPost('/run', payload);
}

// Get available libraries — called once on startup
async function getInstalledModules() {
  if (isMock) return getMock().getInstalledModules();
  return httpGet('/installed-modules');
}

// Get capabilities
async function getCapabilities() {
  if (isMock) return getMock().getCapabilities();
  return httpGet('/capabilities');
}

// Health check
async function health() {
  if (isMock) return { status: 'ok', mode: 'mock' };
  return httpGet('/health');
}

module.exports = { createSession, deleteSession, execute, command, getInstalledModules, getCapabilities, health, isMock };
