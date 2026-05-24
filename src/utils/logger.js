// src/utils/logger.js
// Simple structured logger — keeps output readable during multi-turn loops

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'];

const colors = {
  debug: '\x1b[36m', // cyan
  info:  '\x1b[32m', // green
  warn:  '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
};

function log(level, context, message, data = null) {
  if (LEVELS[level] < CURRENT_LEVEL) return;

  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const color = colors[level];
  const tag = `[${level.toUpperCase().padEnd(5)}]`;
  const ctx = context ? `[${context}]` : '';

  let line = `${color}${ts} ${tag}${colors.reset} ${ctx} ${message}`;
  if (data !== null) {
    const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    line += `\n${str}`;
  }
  console.log(line);
}

const logger = {
  debug: (ctx, msg, data) => log('debug', ctx, msg, data),
  info:  (ctx, msg, data) => log('info',  ctx, msg, data),
  warn:  (ctx, msg, data) => log('warn',  ctx, msg, data),
  error: (ctx, msg, data) => log('error', ctx, msg, data),

  // Shorthand for orchestrator step logging
  step: (jobId, stepNum, totalSteps, name, status) => {
    const bar = `[${stepNum}/${totalSteps}]`;
    log('info', `job:${jobId.slice(0, 8)}`, `${bar} ${name} — ${status}`);
  },
};

module.exports = logger;
