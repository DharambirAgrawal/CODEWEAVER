// tests/mock/execifyMock.js
// Simulates Execify API responses for local development — no Docker needed

const logger = require('../../src/utils/logger');

// Simulate delays to mimic real execution
const FAKE_EXEC_DELAY_MS = 300;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Very basic syntax check — catches obvious issues
function hasObviousSyntaxError(code) {
  // Unmatched parentheses (rough check)
  let depth = 0;
  for (const ch of code) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return true;
  }
  if (depth !== 0) return true;
  return false;
}

// Generate a minimal fake xlsx bytes (enough to pass size check)
function fakeXlsxBase64() {
  // PK header for a ZIP file (xlsx is a ZIP)
  const fakeBytes = Buffer.alloc(2000, 0x41); // 2KB of 'A'
  fakeBytes[0] = 0x50; fakeBytes[1] = 0x4B; // PK header
  return fakeBytes.toString('base64');
}

function fakeDocxBase64() {
  const fakeBytes = Buffer.alloc(5000, 0x42);
  fakeBytes[0] = 0x50; fakeBytes[1] = 0x4B;
  return fakeBytes.toString('base64');
}

function fakePdfBase64() {
  const content = Buffer.from('%PDF-1.4 fake pdf content for testing');
  const padded = Buffer.concat([content, Buffer.alloc(1500, 0x20)]);
  return padded.toString('base64');
}

function fakeFileBase64(filename) {
  if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) return fakeXlsxBase64();
  if (filename.endsWith('.docx')) return fakeDocxBase64();
  if (filename.endsWith('.pdf')) return fakePdfBase64();
  return Buffer.from('fake file content for testing purposes').toString('base64');
}

// ─── MOCK SESSION ─────────────────────────────────────────────────────────────
const mockSessions = new Map();

async function createSession() {
  const sessionId = `mock-session-${Date.now()}`;
  mockSessions.set(sessionId, { createdAt: Date.now(), workspace: {} });
  logger.debug('MockExecify', `Session created: ${sessionId}`);
  return {
    session_id: sessionId,
    expires_in: 3600,
    worker: 'mock-worker-0',
  };
}

async function deleteSession(sessionId) {
  mockSessions.delete(sessionId);
  logger.debug('MockExecify', `Session deleted: ${sessionId}`);
  return { deleted: true };
}

// ─── MOCK RUN ─────────────────────────────────────────────────────────────────
async function run(payload) {
  await sleep(FAKE_EXEC_DELAY_MS);

  const { type, language, code, session_id } = payload;

  logger.debug('MockExecify', `run() called`, {
    type,
    language,
    session: session_id,
    codeLength: code?.length,
  });

  // Command type
  if (type === 'command') {
    return {
      success: true,
      stdout: '',
      stderr: '',
      outputFiles: [],
    };
  }

  // Code execution
  if (!code || code.trim().length === 0) {
    return {
      success: false,
      stdout: '',
      stderr: 'No code provided',
      errorType: 'input_validation',
      retryable: false,
    };
  }

  if (hasObviousSyntaxError(code)) {
    return {
      success: false,
      stdout: '',
      stderr: 'SyntaxError: unexpected EOF while parsing',
      errorType: 'syntax_error',
      retryable: false,
    };
  }

  // Check if code mentions saving a file — if so, return it in outputFiles
  const outputFileMatch = code.match(/['"](\/workspace\/[^'"]+)['"]/);
  const outputFiles = [];

  if (outputFileMatch) {
    const filePath = outputFileMatch[1];
    const filename = filePath.split('/').pop();
    outputFiles.push({
      name: filename,
      path: filePath,
      data: fakeFileBase64(filename),
      size: 2000,
    });
    logger.debug('MockExecify', `Simulated output file: ${filename}`);
  }

  return {
    success: true,
    stdout: outputFiles.length > 0
      ? `SUCCESS: file saved to ${outputFileMatch[1]}`
      : 'Function defined successfully',
    stderr: '',
    outputFiles,
    errorType: null,
    retryable: false,
  };
}

// ─── MOCK INSTALLED MODULES ───────────────────────────────────────────────────
async function getInstalledModules() {
  return {
    python: [
      'openpyxl', 'pandas', 'numpy', 'python-docx', 'reportlab',
      'fpdf2', 'matplotlib', 'seaborn', 'csv', 'json', 'os',
      'pathlib', 'datetime', 'collections', 'itertools', 'random',
      'string', 'math', 'io', 'zipfile',
    ],
    node: ['fs', 'path', 'os', 'crypto', 'stream', 'events'],
  };
}

// ─── MOCK CAPABILITIES ────────────────────────────────────────────────────────
async function getCapabilities() {
  return {
    languages: ['python', 'node'],
    commands: ['fetch_url', 'write_file', 'read_file', 'list_dir', 'delete_file', 'zip_files'],
    host_utilities: {
      docx_to_pdf_available: true,
      docx_to_pdf_binary: 'libreoffice',
    },
  };
}

module.exports = { run, createSession, deleteSession, getInstalledModules, getCapabilities };
